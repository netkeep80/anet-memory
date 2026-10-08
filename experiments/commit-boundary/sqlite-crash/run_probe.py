#!/usr/bin/env python3
"""Independent child OS process/restart tests of research SQLite transactional-effect model."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

base = Path(__file__).resolve().parent
script = base / "sqlite_effect_sink.py"
db = base / "run-54-sqlite.db"
for p in [db, Path(str(db)+"-wal"), Path(str(db)+"-shm")]:
    p.unlink(missing_ok=True)
root = [sys.executable, str(script), "--db", str(db)]

def call(op, *flags, expect=None):
    p = subprocess.run([*root,op,*flags], capture_output=True, text=True)
    output = json.loads(p.stdout) if p.stdout.strip() else None
    if expect is not None:
        assert output is not None and output["state"] == expect, (op,flags,p.returncode,p.stdout,p.stderr)
    return p, output

_, initialized = call("init",expect="READY")
call("install",expect="AUTHORITY_INSTALLED")

# Crash before DB commit, process is genuinely SIGKILLed with no cleanup.
p, _ = call("apply","--key","before", "--failpoint","before-commit")
assert p.returncode == -9, p.returncode
_, s = call("state")
assert (s["count"],s["effects"]) == (0,0), s

# Replay previously uncommitted request; one durable effect.
call("apply","--key","before",expect="APPLIED")
_, s = call("state")
assert (s["count"],s["effects"]) == (1,1), s

# Commit is durable, then worker dies before emitting ACK.
p, _ = call("apply","--key","after", "--failpoint","after-commit-before-ack")
assert p.returncode == -9, p.returncode
_, s = call("state")
assert (s["count"],s["effects"]) == (2,2), s
call("apply","--key","after",expect="ALREADY_APPLIED")
_, s = call("state")
assert (s["count"],s["effects"]) == (2,2), s

# Same key divergent content must not be replayed.
call("apply","--key","after","--payload-hex","646966666572656e74",expect="IDEMPOTENCY_KEY_CONFLICT")

# Eight ACTUAL OS child processes concurrently attempt the same new effect.
procs = [subprocess.Popen([*root,"apply","--key","race"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(8)]
replies = []
for proc in procs:
    out,err=proc.communicate(timeout=35)
    assert proc.returncode == 0,(proc.returncode,err)
    replies.append(json.loads(out)["state"])
assert sorted(replies) == ["ALREADY_APPLIED"]*7+["APPLIED"],replies
_, s = call("state")
assert (s["count"],s["effects"]) == (3,3),s

# New generation has its own authority; stale workers rejected.
call("install","--generation","2","--commit","b"*40,expect="AUTHORITY_INSTALLED")
call("apply","--key","stale",expect="STALE_OR_FUTURE_GENERATION")
call("apply","--key","latest","--generation","2","--commit","b"*40,expect="APPLIED")
call("install","--generation","1",expect="STALE_AUTHORITY")
call("install","--generation","2","--commit","c"*40,expect="AUTHORITY_FORK")
_, s = call("state")
assert (s["count"],s["effects"],s["generation"],s["commit_sha"]) == (4,4,2,"b"*40),s
print(json.dumps({
 "classification":"PASS_LOCAL_SQLITE_PROCESS_CRASH_REPLAY",
 "sqlite_version":initialized["sqlite_version"],
 "hostname":os.uname().nodename,
 "before_commit_sigkill":"ROLLBACK_CONFIRMED",
 "after_commit_before_ack_sigkill":"DURABLE_EFFECT_REPLAY_DEDUP_CONFIRMED",
 "concurrent_independent_processes":8,
 "concurrent_results":{"APPLIED":replies.count("APPLIED"),"ALREADY_APPLIED":replies.count("ALREADY_APPLIED")},
 "stale_worker":"REJECTED",
 "authority_regression":"REJECTED",
 "same_generation_fork":"REJECTED",
 "final_state":s,
 "script_sha256":hashlib.sha256(script.read_bytes()).hexdigest(),
 "runner_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
 "database_size_bytes":db.stat().st_size,
},indent=2,sort_keys=True))
