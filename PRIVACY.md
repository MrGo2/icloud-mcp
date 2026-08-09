# Privacy policy

Effective 10 August 2026. Applies to the mcp-icloud server (the software you
run), not to any AI client you connect it to.

## The short version

mcp-icloud runs on your machine and works for you. It has no servers of its
own, no analytics, no telemetry, and no way to see your data. The author
never receives anything.

## What the software touches, and where it goes

When a connected AI client (Claude Desktop, for example) calls a tool, the
server reads or writes data in your Apple services: mail, calendar events,
contacts, reminders, notes, messages, and Safari tabs. Two things happen
with that data, and nothing else.

First, tool results are returned to the AI client that asked for them. What
that client does with the data is governed by its own privacy policy, not
this one. Nothing is sent anywhere unless a client you connected asks.

Second, in cloud mode the server talks to Apple's servers on your behalf
(imap.mail.me.com, smtp.mail.me.com, caldav.icloud.com,
contacts.icloud.com), over TLS, authenticated with credentials you
provided. In local mode the server makes no network connections at all; it
drives the apps already on your Mac, and macOS asks for your consent per
app before any of that works. You can revoke that consent at any time in
System Settings under Privacy and Security.

## Credentials

Cloud mode needs your iCloud address and an app-specific password. You
store them yourself, either in a local .env file or in the macOS Keychain
when you install the desktop extension. The server reads them once at
startup, sends them only to Apple, and never writes them to any log.
Diagnostics print a fixed mask instead of the value. Local mode needs no
credentials at all.

## What is kept

Nothing. The server is stateless: no database, no cache, no files written.
When it stops, nothing of yours remains in it.

## Third parties

There are none. No data is sold, shared, or transferred to anyone. The only
parties that ever see your data are Apple (which already has it) and the AI
client you chose to connect.

## Changes and contact

Changes to this policy are made in this file, in the open, with the
repository's history as the record. Questions and concerns:
https://github.com/MrGo2/icloud-mcp/issues
