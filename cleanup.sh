#!/bin/bash
# Cleanup script for fileconvert temporary files

LOGFILE="/home/ubuntu/fileconvert/cleanup.log"

# --- Log rotation: keep only last 500 lines ---
if [ -f "$LOGFILE" ]; then
    tail -n 500 "$LOGFILE" > "${LOGFILE}.tmp" && mv "${LOGFILE}.tmp" "$LOGFILE"
fi

# --- Start logging ---
echo "Cleanup started at $(date)" >> "$LOGFILE"

# --- Delete files older than 30 minutes ---
# Uploads folder
if [ -d "/home/ubuntu/fileconvert/uploads" ]; then
    find /home/ubuntu/fileconvert/uploads -type f -mmin +30 -delete
fi

# Tmp folder
if [ -d "/home/ubuntu/fileconvert/tmp" ]; then
    find /home/ubuntu/fileconvert/tmp -type f -mmin +30 -delete
fi

# --- End logging ---
echo "Cleanup finished at $(date)" >> "$LOGFILE"
echo "---------------------------------------" >> "$LOGFILE"

