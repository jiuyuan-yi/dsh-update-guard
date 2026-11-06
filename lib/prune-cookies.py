# Keep only the newest dsh-auth-* cookie, delete the rest.
#
# The desktop app picks a random loopback port each launch, and the host names the
# auth cookie after host:port. RFC 6265 keys cookies by domain/path/name, so every
# port adds a new cookie that never evicts the others; around 70 of them the request
# header passes Node's 16 KB limit and every request dies in header parsing with
# "Web authentication failed". Pruning before launch keeps the jar at one entry.
#
# Runs only while the app is closed, so the database is not locked.
import sqlite3
import sys

if len(sys.argv) < 2:
    print('PRUNE skip=no-db-arg')
    sys.exit(0)

db = sys.argv[1]

try:
    con = sqlite3.connect(db)
    rows = con.execute(
        "select host_key, name from cookies where name like 'dsh-auth-%' "
        "order by creation_utc desc").fetchall()
except Exception as exc:                      # report, never raise
    print('PRUNE error=' + type(exc).__name__)
    sys.exit(0)

if len(rows) <= 1:
    print('PRUNE kept=%d removed=0' % len(rows))
    sys.exit(0)

removed = 0
for host, name in rows[1:]:
    try:
        con.execute('delete from cookies where host_key=? and name=?', (host, name))
        removed += 1
    except Exception:
        pass

try:
    con.commit()
    con.close()
except Exception:
    pass

print('PRUNE kept=1 removed=%d' % removed)
