# Keystone — Architecture & Design Decisions

## Purpose
Family habit/task planner with a plan → commit → reward loop.
Users: Nyra, Krishna, wife (extensible to bring-your-own-Sheet for others).

## Stack
- Static HTML/JS, GitHub Pages hosting (no backend server)
- Google Sheets as the data layer (not Drive-file-JSON, not folder-schema)
- Google OAuth (shared client from nyra-bhajans Cloud project) for writes
- Public API key for anonymous reads (link-shared Sheets)

## Data model
Habits (recurring, daily-reset, missed ≠ carried forward) vs Tasks
(persistent until done, does carry forward) — deliberately different
lifecycle objects, not the same row type. See ROADMAP.md Phase 1 for
full Sheet tab schema.

## Reward model
Checkpoints group items and carry a reward (fixed or open/pick-from-pool).
Rewards are parent-GRANTED, never automatic — a checkpoint hitting 100%
just surfaces "ready," a human decides when to grant it (including
partial-completion judgment calls).

## Current phase
Phase 0 (repo bootstrap) — see ROADMAP.md for full phase breakdown.

## Conventions
- CC prompts are the implementation handoff artifact; scoping happens
  in chat first
- Every CC prompt ends with an instruction to update this file
- Config/data-driven where possible — avoid one-off logic per habit/task
