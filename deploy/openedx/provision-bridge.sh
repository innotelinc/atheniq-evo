#!/usr/bin/env bash
# Create the Open edX service user the bridge writes grades as, and print an
# OAuth2 access token for it.
#
# Run inside the LMS container (or on the LMS host), with the LMS settings
# available:
#
#   ./provision-bridge.sh                       # creates/updates the user
#   ./provision-bridge.sh --course course-v1:Org+Course+Run
#
# The course flag also grants course-author rights on that course, which is what
# the gradebook bulk-update endpoint requires. It is per course on purpose: the
# bridge can score the courses it is told to score, not the whole estate.
set -euo pipefail

SERVICE_USER="${LMS_BRIDGE_USER:-atheniq-bridge}"
SERVICE_EMAIL="${LMS_BRIDGE_EMAIL:-bridge@atheniq.institute}"
COURSE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --course) COURSE="${2:-}"; shift 2 ;;
    *) echo "usage: $0 [--course course-v1:Org+Course+Run]" >&2; exit 2 ;;
  esac
done

if [ -z "${DJANGO_SETTINGS_MODULE:-}" ]; then
  export DJANGO_SETTINGS_MODULE=lms.envs.tutor.production
fi

python - "$SERVICE_USER" "$SERVICE_EMAIL" "$COURSE" <<'PY'
import sys

import django

django.setup()

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from opaque_keys.edx.keys import CourseKey
from student.roles import CourseStaffRole

username, email, course = sys.argv[1], sys.argv[2], sys.argv[3]
User = get_user_model()

user, created = User.objects.get_or_create(
    username=username,
    defaults={"email": email, "is_staff": False, "is_active": True},
)
if created:
    # A random unusable password: this account signs in with tokens, never a form.
    user.set_unusable_password()
    user.save()
    print(f"created {username} <{email}>")
else:
    print(f"found {username} <{email}>")

# Course-author access is what the gradebook write API checks. Scope it to the
# courses the estate actually scores when a course is given.
if course:
    course_key = CourseKey.from_string(course)
    CourseStaffRole(course_key).add_users(user)
    print(f"granted course staff on {course}")

print("ok")
PY

echo
echo "The bridge needs a token this user can present. Create an OAuth2 application"
echo "in the LMS admin (Admin → OAuth2 → Applications) with grant type"
echo "'client credentials', then POST to /oauth2/access_token/ with grant_type,"
echo "client_id and client_secret. Put the access token in LMS_API_TOKEN."
