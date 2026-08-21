#!/usr/bin/env bash
set -euo pipefail

container_name="couchbase-voltagent-test"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

cleanup() {
  docker stop "$container_name" >/dev/null 2>&1 || true
  docker rm "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() {
  local description="$1"
  local attempts="$2"
  shift 2

  for _ in $(seq 1 "$attempts"); do
    if "$@"; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $description." >&2
  return 1
}

if docker inspect "$container_name" >/dev/null 2>&1; then
  echo "A Docker container named $container_name already exists; remove or rename it first." >&2
  exit 1
fi

docker run --detach \
  --name "$container_name" \
  --publish 8091-8096:8091-8096 \
  --publish 11210:11210 \
  couchbase/server:enterprise-8.0.0 >/dev/null

wait_for "the Couchbase Web Console" 120 \
  curl --fail --silent --output /dev/null http://127.0.0.1:8091/ui/index.html

curl --fail --silent --show-error \
  --request POST http://127.0.0.1:8091/clusterInit \
  --data-urlencode username=Administrator \
  --data-urlencode password=password \
  --data-urlencode port=SAME \
  --data-urlencode services=kv,n1ql,index \
  --data-urlencode memoryQuota=512 \
  --data-urlencode indexMemoryQuota=512 \
  --data-urlencode indexerStorageMode=plasma \
  --data-urlencode clusterName=voltagent-test \
  --data-urlencode sendStats=false >/dev/null

wait_for "cluster initialization" 120 \
  curl --fail --silent --output /dev/null --user Administrator:password \
  http://127.0.0.1:8091/pools/default

curl --fail --silent --show-error \
  --user Administrator:password \
  --request POST http://127.0.0.1:8091/pools/default/buckets \
  --data-urlencode name=voltagent \
  --data-urlencode bucketType=couchbase \
  --data-urlencode ramQuotaMB=256 \
  --data-urlencode replicaNumber=0 \
  --data-urlencode flushEnabled=1 >/dev/null

wait_for "the voltagent bucket" 120 \
  curl --fail --silent --output /dev/null --user Administrator:password \
  http://127.0.0.1:8091/pools/default/buckets/voltagent

wait_for "the Query Service" 180 \
  curl --fail --silent --output /dev/null --user Administrator:password \
  --request POST http://127.0.0.1:8093/query/service \
  --data-urlencode 'statement=SELECT 1 AS ready'

CB_LIVE_TEST=1 \
CB_CONNECTION_STRING=couchbase://127.0.0.1 \
CB_USERNAME=Administrator \
CB_PASSWORD=password \
CB_BUCKET=voltagent \
CB_CLEANUP=1 \
"$@"
