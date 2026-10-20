package main

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3API is the slice of the S3 client the exporter needs. Tests inject a
// deterministic fake instead of a network endpoint.
type S3API interface {
	ListObjectsV2(ctx context.Context, params *s3.ListObjectsV2Input, optFns ...func(*s3.Options)) (*s3.ListObjectsV2Output, error)
	GetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	PutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

func newS3Client(ctx context.Context, source S3Source) (S3API, error) {
	credentialsValue, err := loadS3Credentials(source.CredentialsFile)
	if err != nil {
		return nil, err
	}

	awsConfiguration, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(source.Region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			credentialsValue.AccessKeyID,
			credentialsValue.SecretAccessKey,
			"",
		)),
		// Garage does not implement the newest AWS checksum trailers. Body
		// integrity is our own SHA-256; let the SDK add checksums only where
		// an operation requires them.
		awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
		awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
	)
	if err != nil {
		return nil, errors.New("configure s3 client")
	}

	return s3.NewFromConfig(awsConfiguration, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(source.Endpoint)
		options.UsePathStyle = true
	}), nil
}

// isMissingObject reports a GET for a key that no longer exists. A missing
// bucket is not a missing object.
func isMissingObject(err error) bool {
	var noSuchKey *types.NoSuchKey
	if errors.As(err, &noSuchKey) {
		return true
	}
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) && coded.ErrorCode() != "" {
		switch coded.ErrorCode() {
		case "NoSuchKey", "NotFound":
			return true
		default:
			return false
		}
	}
	var status interface{ HTTPStatusCode() int }
	return errors.As(err, &status) && status.HTTPStatusCode() == 404
}

// exportBucketInto lists the bucket with explicit pagination and GETs every
// object. Keys are copied verbatim into generated archive files; no key is
// ever used as a filesystem path.
func exportBucketInto(ctx context.Context, source S3Source, spool *Spool, state *exportState, client S3API) error {
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: aws.String(source.Bucket),
	})

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("list bucket %q failed", source.Bucket)
		}
		for _, object := range page.Contents {
			key := aws.ToString(object.Key)
			if key == "" {
				return fmt.Errorf("bucket %q contains an empty key", source.Bucket)
			}

			input := &s3.GetObjectInput{
				Bucket: aws.String(source.Bucket),
				Key:    aws.String(key),
			}
			if object.ETag != nil && *object.ETag != "" {
				input.IfMatch = object.ETag
			}

			output, err := client.GetObject(ctx, input)
			if err != nil {
				if isMissingObject(err) {
					// Deleted after listing: record it and keep going. A
					// changed object (412) still fails explicitly.
					state.addVanished(source.Bucket, key)
					continue
				}
				return fmt.Errorf("read object in bucket %q failed", source.Bucket)
			}

			path := state.objectPath()
			writer, err := spool.Create(path)
			if err != nil {
				_ = output.Body.Close()
				return err
			}

			written, copyErr := io.Copy(writer, output.Body)
			closeBodyErr := output.Body.Close()
			closeErr := writer.Close()
			if copyErr != nil || closeBodyErr != nil {
				_ = spool.Remove(path)
				if errors.Is(copyErr, ErrSpoolLimit) {
					return copyErr
				}
				return fmt.Errorf("read object in bucket %q failed", source.Bucket)
			}
			if closeErr != nil {
				_ = spool.Remove(path)
				if errors.Is(closeErr, ErrSpoolLimit) {
					return closeErr
				}
				return fmt.Errorf("store object from bucket %q failed", source.Bucket)
			}

			if output.ContentLength != nil && *output.ContentLength != written {
				_ = spool.Remove(path)
				return fmt.Errorf("object in bucket %q changed while reading", source.Bucket)
			}
			if object.Size != nil && *object.Size != written {
				_ = spool.Remove(path)
				return fmt.Errorf("object in bucket %q changed while reading", source.Bucket)
			}
			if object.ETag != nil && output.ETag != nil && *object.ETag != "" && *object.ETag != *output.ETag {
				_ = spool.Remove(path)
				return fmt.Errorf("object in bucket %q changed while reading", source.Bucket)
			}

			state.addFile(ExportFile{
				Path:        path,
				SourcePath:  spoolPath(spool, path),
				Kind:        kindObject,
				Bucket:      source.Bucket,
				Key:         key,
				ContentType: aws.ToString(output.ContentType),
			})
		}
	}
	return nil
}
