"""Consume local output into two private 1 MiB files. Never export it."""
import os
import stat
import sys

directory = None
output = None
try:
    target = os.path.abspath(sys.argv[1])
    allowed = [os.path.join(os.path.expanduser("~"), "emuly", "setup.log"), "/tmp/runner.log", "/tmp/emulator.log"]
    if target not in allowed or os.path.islink(os.path.dirname(target)):
        raise ValueError("unsupported log")
    directory = os.open(os.path.dirname(target), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = os.path.basename(target)
    def open_log():
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ValueError("unsupported log")
        os.fchmod(fd, 0o600)
        return fd
    output = open_log()
    size = os.fstat(output).st_size
    if size > 1048576:
        os.ftruncate(output, 1048576)
        size = 1048576
    try:
        previous = os.open(name + ".previous", os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            if stat.S_ISREG(os.fstat(previous).st_mode):
                os.fchmod(previous, 0o600)
                if os.fstat(previous).st_size > 1048576:
                    os.ftruncate(previous, 1048576)
        finally:
            os.close(previous)
    except OSError:
        pass
    while True:
        chunk = os.read(0, 8192)
        if not chunk:
            break
        if size + len(chunk) > 1048576:
            os.close(output)
            output = None
            os.replace(name, name + ".previous", src_dir_fd=directory, dst_dir_fd=directory)
            output = open_log()
            size = 0
        while chunk:
            written = os.write(output, chunk)
            size += written
            chunk = chunk[written:]
except (OSError, ValueError, IndexError):
    # Drain output on failure so logging never breaks the producer's pipe.
    while os.read(0, 8192):
        pass
finally:
    if output is not None:
        os.close(output)
    if directory is not None:
        os.close(directory)
