#!/bin/zsh
M2=/tmp/m2; LOG=/tmp/g.log
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd /Users/ryanx/code/MyGrokBot/apps/mobile/android || exit 1
for round in $(seq 1 80); do
  ./gradlew -I mirrors.gradle assembleDebug > $LOG 2>&1 && { echo "BUILD OK round $round"; exit 0; }
  coords=$(grep -oE "Could not resolve [a-z][a-zA-Z0-9_.]*:[a-zA-Z0-9._-]+:[0-9][a-zA-Z0-9._-]+" $LOG | awk '{print $4}' | sed 's/\.$//' | sort -u | head -80)
  if [ -z "$coords" ]; then
    for url in $(grep -oE "https://maven[^ ']+\.(pom|jar)" $LOG | sort -u | head -40); do
      rel=${url#https://maven.aliyun.com/repository/}; rel=${rel#google/}; rel=${rel#public/}
      f=$M2/$rel; mkdir -p ${f:h}
      [ -s "$f" ] || curl -sL --max-time 40 -o "$f" "https://maven.aliyun.com/repository/public/$rel"
    done
    coords=$(grep -oE "Could not resolve [a-z][a-zA-Z0-9_.]*:[a-zA-Z0-9._-]+:[0-9][a-zA-Z0-9._-]+" $LOG | awk '{print $4}' | sed 's/\.$//' | sort -u | head -80)
    [ -z "$coords" ] && { echo "round $round: stuck"; grep -B2 -A6 "What went wrong" $LOG | head -14; exit 1; }
  fi
  echo "round $round: $(echo "$coords" | wc -l | tr -d ' ') coords"
  for gav in ${(f)coords}; do
    grp=${gav%%:*}; rest=${gav#*:}; art=${rest%%:*}; ver=${rest#*:}
    [ "$ver" = "$rest" ] && continue
    gdir=$(echo $grp | sed 's/\./\//g')
    dir=$M2/$gdir/$art/$ver; mkdir -p $dir
    for ext in pom jar module; do
      f=$dir/$art-$ver.$ext; [ -s "$f" ] && continue
      for m in "https://maven.aliyun.com/repository/public" "https://dl.google.com/dl/android/maven2" "https://plugins.gradle.org/m2" "https://repo1.maven.org/maven2"; do
        code=$(curl -sL --max-time 45 -w "%{http_code}" -o "$f.part" "$m/$gdir/$art/$ver/$art-$ver.$ext")
        if [ "$code" = "200" ] && [ $(stat -f%z "$f.part" 2>/dev/null || echo 0) -gt 80 ]; then mv "$f.part" "$f"; break; fi
        rm -f "$f.part"
      done
    done
  done
done
echo exhausted; grep -B2 -A8 "What went wrong" $LOG | head -20
