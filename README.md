# iiwiiInsider

Hi, I'm **@iiwiiInsider**. This page updates automatically with activity from my public GitHub repositories.

## Repository activity

Latest commits and GitHub Actions runs across my 25 most recently updated public repositories:

![Repository activity dashboard](./assets/repo-dashboard.svg)

## Commit pulse

Recent public push activity visible in GitHub's most recent 300 events:

![Animated commit activity pulse](./assets/commit-pulse.svg)

The dashboard refreshes daily and whenever its generator changes. To include Actions runs from other repositories reliably, add a fine-grained personal access token as the `PROFILE_GITHUB_TOKEN` Actions secret. Grant it read-only **Actions** and **Contents** access to the repositories to display; leave it unset to use the workflow's built-in token. Profile graphics are still pushed with the profile repository's built-in workflow token. If a run cannot be read, the dashboard labels it `UNAVAILABLE` rather than treating it as a repository with no runs.
