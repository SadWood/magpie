package plugin

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOptionsPatchPreservesUnknownNumbers(t *testing.T) {
	storeSandbox(t)
	writeList(t, `{"futureRoot":{"n":9007199254740997},"plugins":[{"spec":"alpha","futureEntry":{"n":9007199254740999},"options":{"unknown":9007199254740993,"keyPolicies":{"key-a":{"future":{"n":9007199254740995},"recall":false}}}},{"spec":"beta"}]}`)
	_, version, err := OptionsSnapshot("alpha")
	if err != nil {
		t.Fatal(err)
	}
	changes := []OptionChange{{Path: []string{"keyPolicies", "key-a", "recall"}, Value: json.RawMessage(`true`)}}
	if _, _, err := CompareAndPatchOptions("alpha", version, changes); err != nil {
		t.Fatal(err)
	}
	if err := SetOff("beta", true); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(listPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"9007199254740993", "9007199254740995", "9007199254740997", "9007199254740999", `"recall": true`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("lost %s in %s", want, b)
		}
	}
}

func TestOptionsCompareAndSet(t *testing.T) {
	storeSandbox(t)
	writeList(t, `{"plugins":[{"spec":"alpha","options":{"secret":"synthetic","future":{"v":1}}},{"spec":"beta","options":{"x":1}}]}`)
	original, version, err := OptionsSnapshot("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOptions("beta", map[string]any{"x": 2}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := CompareAndSetOptions("alpha", version, map[string]any{"lost": true}); !errors.Is(err, ErrOptionsConflict) {
		t.Fatalf("stale write: %v", err)
	}
	now, next, err := OptionsSnapshot("alpha")
	if err != nil || now["secret"] != "synthetic" || now["future"] == nil {
		t.Fatalf("options lost: %v %v", now, err)
	}
	original["added"] = true
	saved, _, err := CompareAndSetOptions("alpha", next, original)
	if err != nil || saved["secret"] != "synthetic" || saved["future"] == nil || saved["added"] != true {
		t.Fatalf("save: %v %v", saved, err)
	}
	writeList(t, `{"plugins":[`)
	if _, _, err := OptionsSnapshot("alpha"); err == nil {
		t.Fatal("partial file was treated as options")
	}
	if _, _, err := CompareAndSetOptions("alpha", next, map[string]any{}); err == nil {
		t.Fatal("wrote over partial file")
	}
	b, _ := os.ReadFile(listPath())
	if string(b) != `{"plugins":[` {
		t.Fatalf("partial file changed: %s", b)
	}
}

// The child holds the real OS file lock until released by the parent.
func TestOptionsLockChild(t *testing.T) {
	dir := os.Getenv("MAGPIE_CAS_CHILD")
	if dir == "" {
		t.Skip("child only")
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	unlock, err := lockList()
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if err := os.WriteFile(filepath.Join(dir, "held"), []byte("held"), 0600); err != nil {
		t.Fatal(err)
	}
	// Parent closes stdin to release; no sleep or network.
	var b [1]byte
	_, _ = os.Stdin.Read(b[:])
}

func TestOptionsWaitForOtherProcess(t *testing.T) {
	dir := storeSandbox(t)
	writeList(t, `{"plugins":[{"spec":"alpha","options":{"v":1}}]}`)
	child := exec.Command(os.Args[0], "-test.run=^TestOptionsLockChild$", "-test.count=1")
	child.Env = append(os.Environ(), "MAGPIE_CAS_CHILD="+dir)
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); child.Process.Kill(); child.Wait() })
	// A pipe handshake is preferable, but the child uses a marker to avoid
	// mixing test harness output with the signal.
	for i := 0; i < 1000; i++ {
		if _, err := os.Stat(filepath.Join(dir, "held")); err == nil {
			break
		}
		if i == 999 {
			t.Fatal("child did not acquire lock")
		}
		time.Sleep(time.Millisecond * 5)
	}
	done := make(chan error, 1)
	go func() { done <- SetOptions("alpha", map[string]any{"v": 2}) }()
	select {
	case <-done:
		t.Fatal("write ignored other process lock")
	case <-time.After(100 * time.Millisecond):
	}
	stdin.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := child.Wait(); err != nil && !strings.Contains(err.Error(), "already") {
		t.Fatal(err)
	}
	got, _, err := OptionsSnapshot("alpha")
	if err != nil || got["v"] != json.Number("2") {
		t.Fatalf("after release: %v %v", got, err)
	}
}

func TestOptionsCASChild(t *testing.T) {
	dir := os.Getenv("MAGPIE_CAS_RACE_DIR")
	if dir == "" {
		t.Skip("child only")
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	_, version, err := OptionsSnapshot("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ready-"+os.Getenv("MAGPIE_CAS_WRITER")), []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	var b [1]byte
	_, _ = os.Stdin.Read(b[:])
	_, _, err = CompareAndSetOptions("alpha", version, map[string]any{"writer": os.Getenv("MAGPIE_CAS_WRITER")})
	result := "ok"
	if errors.Is(err, ErrOptionsConflict) {
		result = "conflict"
	} else if err != nil {
		result = err.Error()
	}
	if err := os.WriteFile(filepath.Join(dir, "result-"+os.Getenv("MAGPIE_CAS_WRITER")), []byte(result), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestOptionsCASAcrossProcesses(t *testing.T) {
	dir := storeSandbox(t)
	writeList(t, `{"plugins":[{"spec":"alpha","options":{"v":1}}]}`)
	var children []*exec.Cmd
	var inputs []io.WriteCloser
	for _, name := range []string{"one", "two"} {
		child := exec.Command(os.Args[0], "-test.run=^TestOptionsCASChild$", "-test.count=1")
		child.Env = append(os.Environ(), "MAGPIE_CAS_RACE_DIR="+dir, "MAGPIE_CAS_WRITER="+name)
		input, err := child.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		children = append(children, child)
		inputs = append(inputs, input)
	}
	t.Cleanup(func() {
		for _, c := range children {
			_ = c.Process.Kill()
			_ = c.Wait()
		}
	})
	for _, name := range []string{"one", "two"} {
		for i := 0; i < 1000; i++ {
			if _, err := os.Stat(filepath.Join(dir, "ready-"+name)); err == nil {
				break
			}
			if i == 999 {
				t.Fatal("child did not take snapshot")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	for _, input := range inputs {
		_ = input.Close()
	}
	for _, child := range children {
		if err := child.Wait(); err != nil {
			t.Fatal(err)
		}
	}
	one, err := os.ReadFile(filepath.Join(dir, "result-one"))
	if err != nil {
		t.Fatal(err)
	}
	two, err := os.ReadFile(filepath.Join(dir, "result-two"))
	if err != nil {
		t.Fatal(err)
	}
	if !((string(one) == "ok" && string(two) == "conflict") || (string(two) == "ok" && string(one) == "conflict")) {
		t.Fatalf("expected one success and one conflict, got %q and %q", one, two)
	}
}
