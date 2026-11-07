# Maren benchmark suite

- Run ID: `2026-11-07T22-00-59-682Z`
- Status: **failed**
- Git commit tested: `c9ae32bfd1e23cc3b397eeffdd6260f3b7a80d09`
- MongoDB database: `maren_benchmark`
- Redis: Upstash Redis REST
- Dataset: 100000 products; fixed seed 0x4d415245

## Machine

- OS: win32 10.0.26300
- Architecture: x64
- Node.js: v24.18.0
- CPU: 12th Gen Intel(R) Core(TM) i5-12450H (12 logical CPUs)
- Memory: 8212975616 bytes total; 787927040 bytes free at suite start

## Product listing index explain

Query: `products.find({}).sort({ createdAt: -1 }).limit(10).explain("executionStats")`.

Index restoration after throughput tests: restored 0 original createdAt index(es).

| Index scenario | Plan classification | Check | Documents examined | Execution time (ms) | Winning plan stages |
|---|---|---:|---:|---:|---|
| A | COLLSCAN+SORT | PASS | 100000 | 370 | SORT, COLLSCAN |
| B | IXSCAN | PASS | 10 | 1 | LIMIT, FETCH, IXSCAN |

## Product listing throughput

Endpoint: `/api/v1/products?page=1&limit=10&sort=newest`; Autocannon uses 10 connections for 30 seconds. Scenario C performs a successful warm-up request first.

| Scenario | Status | Requests/sec | Average latency (ms) | P99 latency (ms) | Errors | Raw result |
|---|---|---:|---:|---:|---:|---|
| A | completed | 14.1 | 711.38 | 1255 | 0 | [Raw JSON](./results/throughput-2026-11-07T22-00-59-682Z-A.json) |
| B | completed | 52.14 | 191.16 | 447 | 0 | [Raw JSON](./results/throughput-2026-11-07T22-00-59-682Z-B.json) |
| C | completed | 167.5 | 59.3 | 75 | 0 | [Raw JSON](./results/throughput-2026-11-07T22-00-59-682Z-C.json) |

## Inventory race test

Target: exactly 20 repetitions at each concurrency level (2, 10, 50, 100 buyers), one stock unit; each HTTP request has a 120-second timeout.

| Simultaneous buyers | Runs | Passed | Failed | Successful orders | Stock rejections | Final stock 0 | Oversell runs |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 20 | 20 | 0 | 20 | 20 | 20/20 | 0 |
| 10 | 20 | 20 | 0 | 20 | 180 | 20/20 | 0 |
| 50 | 20 | 20 | 0 | 20 | 980 | 20/20 | 0 |
| 100 | 20 | 18 | 2 | 20 | 1904 | 20/20 | 0 |

## Idempotency

| Concurrent requests | Order count | Successful HTTP responses | Final stock | Status |
|---:|---:|---:|---:|---|
| 50 | 1 | 1 | 0 | PASS |

## Suite stages

| Stage | Status | Exit code | Error |
|---|---|---:|---|
| seed | passed | 0 |  |
| product | passed | 0 |  |
| correctness | failed | 1 |  |

## Reproduce

The benchmark scripts use the production-configured Upstash Redis REST client and credentials. MongoDB connects explicitly to `BENCHMARK_DB_NAME` using `BENCHMARK_MONGO_URI` as the cluster URI; the URI's database path is not used as the target database. Seeding replaces only the `products` collection in that dedicated database. The suite also creates temporary buyer/product/order fixtures there and cleans them up.

From the repository root in PowerShell, with `BENCHMARK_MONGO_URI`, `BENCHMARK_DB_NAME`, Redis credentials, and application JWT secrets in `backend/.env`:

```powershell
npm --prefix backend run benchmark:all
```

The database name must contain `benchmark`. The suite exits non-zero if setup or any verification stage fails. Raw stage and per-scenario JSON files are saved under `benchmarks/results/`.

## Claim reproduction summary

- 100,000-product deterministic seed: passed
- Index explain comparison: 2/2 expected plans
- Throughput scenarios recorded: 3/3
- Inventory races passed: 78/80
- Idempotency created exactly one order: yes

Raw suite output: [suite-2026-11-07T22-00-59-682Z.json](./results/suite-2026-11-07T22-00-59-682Z.json)
