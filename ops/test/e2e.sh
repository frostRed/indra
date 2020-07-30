#!/usr/bin/env bash
set -e

root="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." >/dev/null 2>&1 && pwd )"
project="`cat $root/package.json | grep '"name":' | head -n 1 | cut -d '"' -f 4`"

MNEMONIC="${MNEMONIC:=candy maple cake sugar pudding cream honey rich smooth crumble sweet treat}"
chainid="$1"

INDRA_CHAIN_URL="${INDRA_CHAIN_URL:-http://172.17.0.1:8545}"
INDRA_NODE_URL="${INDRA_NODE_URL:-http://172.17.0.1:3000}"

echo "Starting bot in env: LOG_LEVEL=$LOG_LEVEL | INDRA_CHAIN_URL=$INDRA_CHAIN_URL | INDRA_NODE_URL=$INDRA_NODE_URL | MNEMONIC=$MNEMONIC"

if [[ -t 0 && -t 1 && -t 2 ]]
then interactive="--interactive --tty"
else echo "Running in non-interactive mode"
fi

common="$interactive \
  --name=${project}_e2e_test \
  --network=$project \
  --rm"

args="--chain-id $chainid \
  --funder-mnemonic '$MNEMONIC' \
  --log-level $LOG_LEVEL"

exec docker run \
    $common \
    --env="INDRA_CHAIN_URL=$INDRA_CHAIN_URL" \
    --env="INDRA_NODE_URL=$INDRA_NODE_URL" \
    --env="LOG_LEVEL=$LOG_LEVEL" \
    --env="MNEMONIC=$MNEMONIC" \
    --entrypoint=bash \
    --volume="$root:/root" \
    ${project}_builder -c "cd modules/bot && node dist/src/index.js e2e $args"
