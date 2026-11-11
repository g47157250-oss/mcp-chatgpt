#!/bin/bash
# متابعة مهمة الفيديو حتى الاكتمال — يكتب النتيجة في /tmp/video_result.txt
source /tmp/sid.env
TID=0e88818d-85f5-470a-bb01-89f449852892
for i in $(seq 1 40); do
  sleep 30
  R=$(curl -s --max-time 60 -X POST http://localhost:3000/mcp \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SID" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":100,\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$TID\"}}}" \
    | grep -o '"text":"[^"]*"')
  echo "[$i] ${R:0:400}"
  if echo "$R" | grep -qE "success|فشلت"; then echo "$R" > /tmp/video_result.txt; break; fi
done
