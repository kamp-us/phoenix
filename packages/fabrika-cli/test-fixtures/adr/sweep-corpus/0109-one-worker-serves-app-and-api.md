---
id: 0109
title: One worker serves the single-page app and its API
status: accepted
date: 2026-08-01
tags: [platform]
---

# 0109 — One worker serves the single-page app and its API

**What this decides:** The static bundle and the API share one deployment.

## Context
Two deployments for one product doubles the configuration.

## Decision
**One worker serves both the static bundle and the API routes.**

## Consequences
One deploy, one origin.
