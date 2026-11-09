"""Bounded read of structured progress only. Never reads command logs."""
import json
import os
import stat
import sys
import re

def read():
    root = os.path.join(os.path.expanduser("~"), "emuly")
    if not re.fullmatch(r"[a-f0-9]{32}", sys.argv[1]):
        raise ValueError("invalid operation")
    parent = os.path.join(root, ".progress")
    directory = os.path.join(parent, sys.argv[1])
    if os.path.islink(root) or os.path.islink(parent) or os.path.islink(directory):
        raise ValueError("unsafe directory")
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        file = os.open("records", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 1048576 or info.st_uid != os.getuid():
                raise ValueError("unsafe file")
            cursor = int(sys.argv[2])
            if cursor < 0 or cursor > info.st_size:
                raise ValueError("invalid cursor")
            source.seek(cursor)
            records = []
            dropped = 0
            total = 0
            for _ in range(32):
                line = source.readline(2049)
                if not line.endswith(b"\n"):
                    if len(line) < 2049:
                        break  # Partial final line is retried on the next read.
                    # Discard an oversized complete record in bounded chunks. A partial
                    # final record must still leave the committed cursor unchanged.
                    consumed = len(line)
                    while not line.endswith(b"\n") and consumed <= 24576:
                        line = source.readline(min(2049, 24577 - consumed))
                        consumed += len(line)
                        if not line:
                            break
                    total += consumed
                    if not line.endswith(b"\n") or total > 24576:
                        break
                    dropped += 1
                    cursor = source.tell()
                    continue
                total += len(line)
                if total > 24576:
                    break
                try:
                    records.append(json.loads(line))
                except (ValueError, UnicodeError):
                    dropped += 1
                cursor = source.tell()
        try:
            drop = os.open("dropped", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            with os.fdopen(drop, "rb") as count:
                if stat.S_ISREG(os.fstat(count.fileno()).st_mode):
                    dropped = min(100000, dropped + max(0, int(count.read(6))))
        except (OSError, ValueError):
            pass
        return {"cursor": cursor, "records": records, "dropped": dropped}
    finally:
        os.close(fd)

try:
    print("EMULY_PROGRESS=" + json.dumps(read(), separators=(",", ":")))
except (OSError, ValueError, TypeError):
    print("EMULY_PROGRESS_UNAVAILABLE")
