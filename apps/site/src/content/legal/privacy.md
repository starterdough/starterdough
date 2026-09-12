---
title: Privacy policy
description: How this deployment of Starterdough handles personal data.
updated: 2026-09-10
---

> **Template: review with counsel.** This text is a starting point for the operator of a Starterdough
> deployment. Replace every `[placeholder]`, remove the rows and paragraphs that do not apply to how
> *you* configured it, and have it reviewed by a lawyer in your jurisdiction before publishing. The
> date shown above this page comes from the `updated` field in this file's frontmatter. Change it
> when you change the text.

This policy describes how **[Company name]** (“we”) handles personal data when you use the Starterdough
service at **[Service URL]** (the “Service”). Questions go to **[Contact email]**.

## Data we process

**Account data.** When you sign up we store your email address, your name, a hashed password (if you
use one), and whether your email address is verified. If you sign in with GitHub or Google, we
store the identifier the provider gives us and the profile fields you agree to share.

**Security settings.** If you enable two-factor authentication we store the shared secret and your
hashed backup codes. If you register a passkey we store its public key and identifiers. We keep a
list of your active sessions (creation time, expiry, IP address and user agent) so you can review
and revoke them.

**Technical data.** Server logs include IP addresses and request metadata for security and rate
limiting.

## Why we process it

To provide the Service you asked for (your account and the content you store in it), to keep it
secure (verification, two-factor, sessions, rate limits), to communicate about your account, to
comply with legal obligations, and, with your consent, to understand how the Service is used.

## Sharing: our sub-processors

We share data with the processors needed to run the Service, and with no one else. We do not sell
personal data. **Delete the rows that do not apply to this deployment, and name the actual
providers.** Several of them are optional and are only reached when the operator has configured
them.

| Processor | What it receives | Applies when |
| --- | --- | --- |
| **[Hosting provider]** | Everything above: the application, its database and its server logs | Always |
| **[Error tracking, e.g. Sentry]** | Error reports: the failing request’s metadata and your user identifier | When error tracking is enabled |
| **[Analytics, e.g. PostHog]** | Pages visited and product events | When analytics is enabled **and** you accept the consent banner; nothing is sent before that |
| **[Email provider, e.g. Resend]** | The recipient address and the contents of account emails (verification, password reset, email change, account deletion) | When an email provider is configured |

## Retention

Account data is kept while your account exists. You can delete your account from the settings
page; deletion is confirmed by email and removes your account data. Some records may be retained
for as long as the law requires.

## Your rights

Depending on where you live you may have the right to access, correct, export or delete your
personal data, to object to or restrict processing, and to lodge a complaint with a supervisory
authority. Contact **[Contact email]** to exercise them.

## Changes

We will post changes to this page and update the date above. Material changes will be announced
to account holders by email.
