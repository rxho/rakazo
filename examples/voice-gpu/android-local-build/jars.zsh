#!/bin/zsh
M2=/tmp/m2; LOG=/tmp/j.log
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd /Users/ryanx/code/MyGrokBot/apps/mobile/android || exit 1
for round in $(seq 1 40); do
  ./gradlew -I mirrors.gradle assembleDebug > $LOG 2>&1 && { echo "BUILD OK round $round"; exit 0; }
  finds=$(grep -oE "Could not find [a-zA-Z0-9._+-]+\.(jar|pom|module|aar) \([^)]+\)" $LOG | sort -u)
  [ -z "$finds" ] && { echo "round $round: nothing findable"; grep -B2 -A8 "What went wrong" $LOG | head -16; exit 1; }
  echo "round $round: $(echo "$finds" | wc -l | tr -d ' ') files"
  for line in ${(f)finds}; do
    file=$(echo $line | awk '{print $4}')
    gav=$(echo $line | grep -oE "\([^)]+\)" | tr -d '()')
    grp=$(echo $gav | cut -d: -f1); art=$(echo $gav | cut -d: -f2); ver=$(echo $gav | cut -d: -f3)
    gdir=$(echo $grp | sed 's/\./\//g')
    dir=$M2/$gdir/$art/$ver; mkdir -p $dir
    [ -s "$dir/$file" ] && continue
    for m in "https://maven.aliyun.com/repository/public" "https://dl.google.com/dl/android/maven2" "https://mirrors.cloud.tencent.com/nexus/repository/maven-public" "https://plugins.gradle.org/m2" "https://repo1.maven.org/maven2"; do
      code=$(curl -sL --max-time 600 -w "%{http_code}" -o "$dir/$file.part" "$m/$gdir/$art/$ver/$file")
      if [ "$code" = "200" ] && [ $(stat -f%z "$dir/$file.part" 2>/dev/null || echo 0) -gt 80 ]; then mv "$dir/$file.part" "$dir/$file"; break; fi
      rm -f "$dir/$file.part"
    done
  done
done
echo exhausted; grep -B2 -A8 "What went wrong" $LOG | head -16
