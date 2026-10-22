---
"claudexor": patch
---

Keep compatible newer daemons and alternate builds of the same version running
when another macOS app copy connects. Add an explicit idle-only same-version
build switch in Settings, refresh identity before replacement, and coordinate app
lifecycle transactions across copies sharing a service root. An unusable
lifecycle lock is named in the app instead of reported as another action.
When another copy holds that lock, the build offer stays available for an explicit
retry. Engine notices appear alongside Install, and the offline screen shows a
refused lock. Install also refuses before any stop when a newer engine, or another build
of the same version, is already serving.
