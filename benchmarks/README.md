# Maren benchmark suite

The end-to-end benchmark command is:

```powershell
npm --prefix backend run benchmark:all
```

Set `BENCHMARK_MONGO_URI` and `BENCHMARK_DB_NAME` in `backend/.env`. The suite
uses the database selected by `BENCHMARK_DB_NAME` (which must contain
`benchmark`) on the cluster in the URI. It verifies the selected database
before writing. The suite replaces only that database's `products` collection
with exactly 100,000 records generated using a fixed seed; it also creates and
cleans up temporary order-test fixtures in that database.

The application currently uses the production-configured **Upstash Redis REST**
client. The benchmark suite pings the configured Redis service and records the
provider in the generated results. Product list cache keys use a unique
benchmark namespace.

`benchmark:all` runs:

1. A fixed-seed catalog seed.
2. `explain("executionStats")` with and without a `createdAt` index.
3. Autocannon throughput runs with 10 connections for 30 seconds for: no index
   and cache disabled; index and cache disabled; index and warmed cache.
4. Twenty stock-one inventory races at each of 2, 10, 50, and 100 simultaneous
   buyers.
5. Fifty concurrent order requests sharing the same idempotency key.

Raw per-stage and per-scenario output is written to `benchmarks/results/` with
the run timestamp. The generated results summary replaces this file after a
run; it records measured values, failures/skips, the tested commit, machine
details, Redis provider, and reproduction command. No result should be
transcribed from an uncompleted run.
