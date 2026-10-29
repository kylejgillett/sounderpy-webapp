#!/usr/bin/env bash
# Reports the public API's health to Healthchecks.io. Run every 5 minutes by
# sounderpy_healthcheck.timer. Checking the public URL (not localhost) also covers
# Caddy, the HTTPS certificate, and DNS.
#
# Needs HC_PING_URL (your check's ping URL) in /etc/sounderpy-healthcheck.env.
set -u

HEALTH_URL="${HEALTH_URL:-https://api.sounderpy.app/api/health}"
: "${HC_PING_URL:?Set HC_PING_URL in /etc/sounderpy-healthcheck.env}"

if body=$(curl -fsS --max-time 20 "$HEALTH_URL" 2>&1) && grep -q '"online":true' <<<"$body"; then
  curl -fsS --max-time 10 --retry 3 -o /dev/null "$HC_PING_URL"
else
  # /fail marks the check down right away; the body shows up in the Healthchecks event log.
  curl -fsS --max-time 10 --retry 3 -o /dev/null --data-raw "API health check failed: ${body:-no response}" "$HC_PING_URL/fail"
fi
