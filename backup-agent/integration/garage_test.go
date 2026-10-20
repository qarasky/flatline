package integration

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"filippo.io/age"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// garageEnv names the scratch Garage (or other S3) prerequisites. Both
// buckets must already exist and be dedicated to this test: the target must
// be empty, and the whole source bucket is exported.
type garageEnv struct {
	endpoint, region, accessKey, secretKey, sourceBucket, targetBucket string
}

func loadGarageEnv(t *testing.T) garageEnv {
	t.Helper()
	env := garageEnv{
		endpoint:     os.Getenv("FLATLINE_BACKUP_GARAGE_ENDPOINT"),
		region:       os.Getenv("FLATLINE_BACKUP_GARAGE_REGION"),
		accessKey:    os.Getenv("FLATLINE_BACKUP_GARAGE_ACCESS_KEY_ID"),
		secretKey:    os.Getenv("FLATLINE_BACKUP_GARAGE_SECRET_ACCESS_KEY"),
		sourceBucket: os.Getenv("FLATLINE_BACKUP_GARAGE_SOURCE_BUCKET"),
		targetBucket: os.Getenv("FLATLINE_BACKUP_GARAGE_TARGET_BUCKET"),
	}
	if env.region == "" {
		env.region = "garage"
	}
	if env.endpoint == "" || env.accessKey == "" || env.secretKey == "" ||
		env.sourceBucket == "" || env.targetBucket == "" {
		t.Skip("Garage prerequisite missing: set FLATLINE_BACKUP_GARAGE_{ENDPOINT,ACCESS_KEY_ID," +
			"SECRET_ACCESS_KEY,SOURCE_BUCKET,TARGET_BUCKET} (dedicated scratch buckets, empty target)")
	}
	return env
}

func (e garageEnv) client(t *testing.T) *s3.Client {
	t.Helper()
	cfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion(e.region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(e.accessKey, e.secretKey, "")),
		awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
		awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
	)
	if err != nil {
		t.Fatal(err)
	}
	return s3.NewFromConfig(cfg, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(e.endpoint)
		options.UsePathStyle = true
	})
}

type seededObject struct {
	key, contentType string
	body             []byte
}

// testGarageRoundTrip exports a real bucket with run-once, verifies the
// bundle offline, restores it into an empty scratch bucket and checks every
// object key, size, SHA-256 and content type against the manifest.
func testGarageRoundTrip(t *testing.T) {
	env := loadGarageEnv(t)
	ctx := context.Background()
	client := env.client(t)

	empty, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: aws.String(env.targetBucket), MaxKeys: aws.Int32(1)})
	if err != nil {
		t.Fatalf("list target bucket: %v", err)
	}
	if len(empty.Contents) != 0 {
		t.Fatalf("target bucket %q must be empty", env.targetBucket)
	}

	prefix := "flatline-it-" + strconv.Itoa(os.Getpid()) + "-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "/"
	seeded := []seededObject{
		{prefix + "a", "text/plain", []byte("first")},
		{prefix + "a/b", "application/json", []byte(`{"nested":true}`)},
		{prefix + "x//y", "application/octet-stream", bytes.Repeat([]byte{0, 1, 2, 255}, 4096)},
		{prefix + "юникод/ключ", "text/plain; charset=utf-8", []byte("unicode")},
		{prefix + "zero", "application/octet-stream", nil},
	}
	for _, object := range seeded {
		_, err := client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:        aws.String(env.sourceBucket),
			Key:           aws.String(object.key),
			Body:          bytes.NewReader(object.body),
			ContentLength: aws.Int64(int64(len(object.body))),
			ContentType:   aws.String(object.contentType),
		})
		if err != nil {
			t.Fatalf("seed %q: %v", object.key, err)
		}
	}
	t.Cleanup(func() {
		for _, object := range seeded {
			_, _ = client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(env.sourceBucket), Key: aws.String(object.key)})
		}
	})

	temp := t.TempDir()
	binary := filepath.Join(temp, "flatline-backup")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = ".."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}

	received := filepath.Join(temp, "received.age")
	server := httptest.NewServer(&receiver{output: received})
	defer server.Close()

	identityPath := filepath.Join(temp, "identity.txt")
	keyOutput, err := exec.Command(binary, "keygen", "--output", identityPath).CombinedOutput()
	if err != nil {
		t.Fatalf("keygen: %v\n%s", err, keyOutput)
	}
	recipient := string(bytes.TrimSpace(keyOutput))

	credentialsPath := filepath.Join(temp, "s3.json")
	writeJSONFile(t, credentialsPath, map[string]string{"accessKeyId": env.accessKey, "secretAccessKey": env.secretKey})
	tokenPath := filepath.Join(temp, "agent.token")
	if err := os.WriteFile(tokenPath, []byte("integration-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(temp, "meks.json")
	writeJSONFile(t, configPath, map[string]any{
		"version":       1,
		"name":          "meks",
		"serverUrl":     server.URL,
		"tokenFile":     tokenPath,
		"recipient":     recipient,
		"stateDir":      filepath.Join(temp, "meks"),
		"spoolMaxBytes": int64(256 << 20),
		"postgres":      []any{},
		"s3": []any{map[string]any{
			"endpoint": env.endpoint, "region": env.region, "bucket": env.sourceBucket,
			"credentialsFile": credentialsPath,
		}},
	})
	if output, err := exec.Command(binary, "run-once", "--config", configPath).CombinedOutput(); err != nil {
		t.Fatalf("run-once: %v\n%s", err, output)
	}
	if output, err := exec.Command(binary, "verify", "--bundle", received, "--identity-file", identityPath).CombinedOutput(); err != nil {
		t.Fatalf("offline verify: %v\n%s", err, output)
	}

	targetConfigPath := filepath.Join(temp, "target.json")
	writeJSONFile(t, targetConfigPath, map[string]any{
		"version":  1,
		"tempDir":  temp,
		"postgres": []any{},
		"s3": []any{map[string]any{
			"endpoint": env.endpoint, "region": env.region, "sourceBucket": env.sourceBucket,
			"bucket": env.targetBucket, "credentialsFile": credentialsPath,
		}},
	})
	manifest := readManifest(t, received, identityPath)
	t.Cleanup(func() {
		for _, entry := range manifest.Entries {
			if entry.Kind == "object" {
				_, _ = client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(env.targetBucket), Key: aws.String(entry.Key)})
			}
		}
	})
	if output, err := exec.Command(binary, "restore", "--bundle", received, "--identity-file", identityPath,
		"--target-config", targetConfigPath).CombinedOutput(); err != nil {
		t.Fatalf("restore: %v\n%s", err, output)
	}
	if output, err := exec.Command(binary, "compare", "--bundle", received, "--identity-file", identityPath,
		"--target-config", targetConfigPath).CombinedOutput(); err != nil {
		t.Fatalf("compare: %v\n%s", err, output)
	}

	byKey := make(map[string]manifestEntry)
	for _, entry := range manifest.Entries {
		if entry.Kind == "object" && entry.Bucket == env.sourceBucket {
			byKey[entry.Key] = entry
		}
	}
	for _, object := range seeded {
		entry, exists := byKey[object.key]
		if !exists {
			t.Fatalf("manifest lacks %q", object.key)
		}
		sum := sha256.Sum256(object.body)
		if entry.Size != int64(len(object.body)) || entry.SHA256 != hex.EncodeToString(sum[:]) ||
			entry.ContentType != object.contentType {
			t.Fatalf("manifest entry for %q = %+v", object.key, entry)
		}
		output, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(env.targetBucket), Key: aws.String(object.key)})
		if err != nil {
			t.Fatalf("restored %q: %v", object.key, err)
		}
		body, err := io.ReadAll(output.Body)
		_ = output.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		restored := sha256.Sum256(body)
		if restored != sum || aws.ToString(output.ContentType) != object.contentType {
			t.Fatalf("restored %q differs: size=%d type=%q", object.key, len(body), aws.ToString(output.ContentType))
		}
	}
}

type manifestEntry struct {
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Bucket      string `json:"bucket"`
	Key         string `json:"key"`
	ContentType string `json:"contentType"`
}

type manifestDocument struct {
	Entries []manifestEntry `json:"entries"`
}

// readManifest decrypts the bundle independently of the agent binary and
// returns its manifest.
func readManifest(t *testing.T, bundlePath, identityPath string) manifestDocument {
	t.Helper()
	identityFile, err := os.Open(identityPath)
	if err != nil {
		t.Fatal(err)
	}
	defer identityFile.Close()
	identities, err := age.ParseIdentities(identityFile)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := os.Open(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	defer bundle.Close()
	decrypted, err := age.Decrypt(bundle, identities...)
	if err != nil {
		t.Fatal(err)
	}
	archive := tar.NewReader(decrypted)
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			t.Fatal("bundle has no manifest")
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Name == "manifest.json" {
			var manifest manifestDocument
			if err := json.NewDecoder(archive).Decode(&manifest); err != nil {
				t.Fatal(err)
			}
			return manifest
		}
	}
}
