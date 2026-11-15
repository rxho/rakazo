#!/bin/zsh
for i in $(seq 1 12); do
  zsh /tmp/feed5.zsh > /tmp/w1.log 2>&1
  grep -q "BUILD OK" /tmp/w1.log && { echo "BUILD OK via feed5 (iter $i)"; exit 0; }
  zsh /tmp/jars.zsh > /tmp/w2.log 2>&1
  grep -q "BUILD OK" /tmp/w2.log && { echo "BUILD OK via jars (iter $i)"; exit 0; }
  n=$(find /tmp/m2 -type f | wc -l | tr -d ' ')
  echo "iter $i: m2=$n; last: $(grep -m1 "Could not" /tmp/j.log | head -c 120)"
done
echo stopped; grep -B2 -A8 "What went wrong" /tmp/j.log | head -14
