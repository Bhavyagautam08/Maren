# Reproducible product-list benchmark

**Status: not run.** The workspace does not have `BENCHMARK_MONGO_URI` or
`BENCHMARK_DB_NAME` configured, so no benchmark measurements or raw Autocannon
results are recorded. The runner refuses to modify indexes until an isolated
database is explicitly configured.

The runner executes these scenarios against
`/api/v1/products?page=1&limit=10&sort=newest`, with 10 connections for 30
seconds and exactly 100,000 products:

1. No `createdAt` index; product-list cache disabled.
2. `createdAt` index present; product-list cache disabled.
3. `createdAt` index present; product-list cache enabled and warmed.

| Scenario | Requests/sec | Average latency (ms) | P99 latency (ms) | Errors | Raw output |
|---|---:|---:|---:|---:|---|
| A | Not run | Not run | Not run | Not run | Not available |
| B | Not run | Not run | Not run | Not run | Not available |
| C | Not run | Not run | Not run | Not run | Not available |

When run, the script writes raw Autocannon JSON under `benchmarks/results/` and
replaces this page with the measured results, Git commit, machine details, and
reproduction command.

## Redis setup

The backend uses its production-compatible Upstash Redis REST client and
credentials (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`). Each
benchmark run uses a unique product-cache namespace, so it does not overwrite or
clear production product-list keys.

## Run

Configure an isolated MongoDB database containing exactly 100,000 products.
`BENCHMARK_DB_NAME` must match the database name in the URI and contain
`benchmark`; the script records and restores any pre-existing indexes on
`createdAt`.

From the repository root in PowerShell:

```powershell
$env:BENCHMARK_MONGO_URI = "<isolated benchmark MongoDB URI>"
$env:BENCHMARK_DB_NAME = "<database name containing benchmark>"
npm --prefix backend run benchmark:products
```

The benchmark MongoDB settings above are intentionally not saved in this
repository. Redis connection settings are loaded by the backend using the same
configuration as the application.
