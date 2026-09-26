# P2.1 Mini product presentation and UI locales

This iteration preserves P1/P2 authentication, recovery, replay protection, quotas,
admin isolation and all points/referral/redemption write semantics. No migration,
grants, runtime environment change, seed or business write is required.

## Product surface

Five tabs remain Home, Activities, Rewards, Invite, Me. The home focus card has one
CTA to the upcoming catalogue; points are a compact member summary. Empty data is
never substituted with synthetic rewards. Four activity templates are presentation
placeholders, not published activities. Games, redemption submission, UID/platform
accounts and benefits are unavailable. Invitation records are real, but no share
link is generated without a published safe invitation contract. Record APIs and
signed pagination are unchanged. Pending rewards are unknown (dash), not zero.

The home rule distinguishes empty data from existing records. It deliberately does
not claim a first visit or infer a lifecycle from local storage. A reliable future
lifecycle signal can extend this rule without changing the page layout.

## Language boundary

`GET /v1/mini/home` adds read-only preferredLanguage, botLanguage, projectLanguage,
telegramLanguage from the authenticated user's exact scope. It does not change
Telegram message-language fallback or update preferred_language.

UI resolution: explicit device selection for the public appKey, existing stored
user preference, Bot default, Brand/project default, Telegram language, fallback.
The deployed test Bot/Brand remain zh-CN. Before authentication the public brand
configuration supplies zh-CN. No country-to-language inference.

zh-CN and en dictionaries are complete. pt-BR, es-MX and fil are selectable; they
explicitly fall back to English until translated. Missing keys return neutral text,
never a key name or undefined. The language pane explains the fallback. Document
language follows the actual rendered dictionary. Numbers/dates use the selected
locale; points use BigInt, not Number. Currency formatting requires an explicit
currency; no user currency is guessed. Stored business values remain unformatted.

Selection persists only as a non-sensitive locale under
`mini-ui-language:<public appKey>`. It is a device preference, not a server account
change or cross-device sync. All users of that browser/app share this device choice.
Blocked storage leaves the choice working in memory. No token, initData, user ID,
Session or secret enters localStorage. Existing runtime does not have column UPDATE
on preferred_language, so this UI work intentionally avoids widening grants.

## Branding

`web/src/mini/brand.ts` contains public presentation configuration: appKey, display
name, monogram/local logo path, forest/ocean theme, default locale, staging marker,
optional HTTPS help URL. Configure one approved app per deployment; server appKey
binding remains authoritative. Never place secrets, upstream URLs or database
configuration here. Components do not use technical Bot/Brand names. IDs and Session
metadata remain on the P1 diagnostic page. Request IDs appear only in an explicit
collapsed diagnostics disclosure.

Operational activity copy belongs to the future published-content layer; current
dictionary cards describe unavailable capabilities, not reward promises.

## Acceptance and rollback

Run backend/PGlite/PostgreSQL17, frontend Vitest, built-asset Playwright, proxy tests,
build and secret/bundle scans. Check 320–430px and wide Desktop container, navigation,
empty records, language selection/reload, recovery, logout and admin scope regression.
Real Telegram Desktop remains a separate user-operated acceptance; do not substitute
mock browser tests for Telegram. No real rewards or fixtures are created.

Rollback both services to the previous main commit. Added home response fields are
backwards compatible. The device language key is harmless to older clients and
requires no cleanup or database rollback. Keep the P1 diagnostic URL available.
