#!/bin/sh
# Parallel-fetch the FunASR image blobs (aliyun caps each connection at ~130KB/s;
# aria2 with 16 connections scales linearly), assemble an OCI layout, and load
# it into docker. Every blob is sha256-verified against the registry manifest.
set -e
REG=https://registry.cn-hangzhou.aliyuncs.com
REPO=funasr_repo/funasr
TAG=funasr-runtime-sdk-online-cpu-0.1.13
BASE="$HOME/rakazo-voice/funasr"
OCI="$BASE/oci"
mkdir -p "$OCI/blobs/sha256"

token() {
  A=$(curl -sI "$REG/v2/" | grep -i www-authenticate | sed 's/.*realm="//;s/".*//')
  S=$(curl -sI "$REG/v2/" | grep -i www-authenticate | sed 's/.*service="//;s/".*//')
  curl -s "${A}?service=${S}&scope=repository:${REPO}:pull" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'
}

fetch_blob() { # $1 = digest (sha256:...), $2 = expected size
  d="$1"; size="$2"; hex="${d#sha256:}"
  f="$OCI/blobs/sha256/$hex"
  if [ -f "$f" ] && [ "$(stat -c%s "$f")" = "$size" ]; then echo "skip $hex (have ${size}B)"; return 0; fi
  T=$(token)
  for try in 1 2 3 4; do
    LOC=$(curl -sI -H "Authorization: Bearer $T" "$REG/v2/$REPO/blobs/$d" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
    if [ -z "$LOC" ]; then echo "no redirect for $hex (try $try), re-minting token"; T=$(token); sleep 3; continue; fi
    aria2c -x16 -s16 -k4M --file-allocation=none --console-log-level=warn \
      --summary-interval=0 -d "$OCI/blobs/sha256" -o "$hex" "$LOC" && break
    echo "aria2 retry $try for $hex"; T=$(token); sleep 3
  done
  got=$(sha256sum "$f" | cut -d' ' -f1)
  if [ "$got" != "$hex" ]; then echo "DIGEST MISMATCH $hex got $got"; exit 1; fi
  echo "ok $hex ($size B)"
}

# manifest + config + layer digests from the index we already validated
python3 - "$OCI" <<'PY' > /tmp/bloblist.txt
import json, sys, os
oci = sys.argv[1]
idx = json.load(open("/tmp/idx.json"))
child = next(m for m in idx["manifests"] if m["platform"]["architecture"] == "amd64")
with open(os.path.join(oci, "blobs", "sha256", child["digest"].split(":", 1)[1]), "wb") as f:
    f.write(open("/tmp/m64.json", "rb").read())
man = json.load(open("/tmp/m64.json"))
print(child["digest"], len(open("/tmp/m64.json","rb").read()), child.get("mediaType", "application/vnd.docker.distribution.manifest.v2+json"))
print(man["config"]["digest"], man["config"]["size"])
for layer in man["layers"]:
    print(layer["digest"], layer["size"])
with open(os.path.join(oci, "index.json"), "w") as f:
    json.dump({"schemaVersion": 2, "manifests": [{
        "mediaType": child.get("mediaType", "application/vnd.docker.distribution.manifest.v2+json"),
        "digest": child["digest"], "size": child["size"],
        "annotations": {"org.opencontainers.image.ref.name": "registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13"},
    }]}, f)
with open(os.path.join(oci, "oci-layout"), "w") as f:
    f.write('{"imageLayoutVersion": "1.0.0"}')
PY

total=0
while read -r digest size _mt; do
  total=$((total + size))
  fetch_blob "$digest" "$size"
done < /tmp/bloblist.txt
echo "ALL BLOBS DONE: $total bytes"

echo "=== tarring + docker load"
tar -C "$OCI" -cf "$BASE/funasr-oci.tar" oci-layout index.json blobs
docker load --input "$BASE/funasr-oci.tar"
echo "=== starting service"
cd "$BASE" && docker compose up -d
docker ps --format "{{.Names}}: {{.Status}}" | head -5
