#!/bin/bash
set -e

########################################
## Setup Env

# 60 sec/min * 30 min = 1800
backup_frequency="1800"
should_restore_backup="no"
backup_file="snapshots/`ls snapshots | grep "$ETH_NETWORK" | sort -r | head -n 1`"

########################################
## Helper functions

function log {
  echo "[ENTRY] $1"
}

function unlock {
  lock="/var/lib/postgresql/data/postmaster.pid"
  sleep 2
  while [[ -f "$lock" ]]
  do
    mode=${1:-fast}
    postmaster="`head -n1 $lock`"
    log "Waiting on lock for pid $postmaster to be released..."
    if [[ -n "`ps -o pid | grep $postmaster`" ]]
    then log "Process $postmaster is running, killing it now.." && kill $postmaster
    else log "Process $postmaster is NOT running, removing the lock now.." && rm $lock
    fi
    sleep 2
  done
}

# Set an exit trap so that the database will do one final backup before shutting down
function cleanup {
  log "Database exiting, creating final snapshot"
  bash backup.sh
  log "Shutting the database down"
  kill "$db_pid"
  unlock smart
  log "Clean exit."
}

trap cleanup SIGTERM

########################################
## Execute

if [[ "$MODE" == "dev" ]]
then log "Starting app in env: `env`"
fi

log "Good morning"

# Is this a fresh database? Should we restore data from a snapshot?
if [[ ! -f "/var/lib/postgresql/data/PG_VERSION" && -f "$backup_file" && "$MODE" != "test" ]]
then 
  log "Fresh postgres db started w backup present, we'll restore: $backup_file"
  should_restore_backup="yes"

  # Start temp database & wait until it wakes up
  log "Starting temp database for backup recovery.."
  unlock fast
  /docker-entrypoint.sh postgres &
  PID=$!
  while ! psql -U $POSTGRES_USER -d $POSTGRES_DB -c "select 1" > /dev/null 2>&1
  do log "Waiting for db to wake up.." && sleep 1
  done
  log "Good morning, Postgres!"

  log "Restoring db snapshot from file $backup_file"
  psql --username=$POSTGRES_USER $POSTGRES_DB < $backup_file
  log "Done restoring db snapshot"

  log "Stopping old database.."
  kill $PID
  unlock smart

else log "Not restoring: Database exists or no snapshots found or in test mode"
fi

# Start backing up the db periodically
log "===> Starting backer upper"
while true
do sleep $backup_frequency && bash backup.sh
done &

# Start database to serve requests from clients
log "===> Starting new database.."
/docker-entrypoint.sh postgres &
db_pid=$!
wait "$db_pid"
