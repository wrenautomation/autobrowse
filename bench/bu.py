"""autobrowse on Browser Use Bench V2 (designs/2026-10-27-bench.md).

The benchmark lives outside this repo, in a clone at CLONE (tag v2.1.1). Its
tasks are encrypted and stay that way on disk: they are decrypted in memory,
and only ids, counts and scores are printed. Never commit or paste a task.

Run with the clone's own Python (bench/bu.sh does this):
  bu.sh list [--n 30] [--seed 7]      strata, skips, the sample's ids
  bu.sh sample <run> [--n] [--seed]   fix a run's task ids
  bu.sh run <run> [--only id] [--max-steps 100] [--timeout 900] [--headed]
  bu.sh judge <run> [--limit 1]       costs OpenAI money: price one first
  bu.sh report <run>
"""

import argparse
import asyncio
import base64
import json
import math
import os
import random
import shutil
import socket
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

CACHE = Path.home() / "Library/Caches/autobrowse/bench"
CLONE = CACHE / "benchmark"
RUNS = CACHE / "runs"
REPO = Path(__file__).resolve().parent.parent
BENCHMARK = "BU_Bench_V2"

def tasks() -> list[dict]:
    sys.path.insert(0, str(CLONE))
    from evaluation import load_tasks  # noqa: PLC0415 - the clone is on the path only now

    return load_tasks(BENCHMARK)


def stratum(task: dict) -> str:
    """The only field the tasks share to stratify on: their rubric revision."""
    return task.get("revision") or "base"


def sample(all_tasks: list[dict], n: int, seed: int) -> tuple[list[str], dict]:
    """
    A seeded sample with each stratum's share of the full set (largest
    remainder). No task is skipped: the tasks that name signing in say not to.
    """
    by: dict[str, list[dict]] = {}
    for t in sorted(all_tasks, key=lambda t: t["task_id"]):
        by.setdefault(stratum(t), []).append(t)
    exact = {s: n * len(ts) / len(all_tasks) for s, ts in by.items()}
    take = {s: math.floor(q) for s, q in exact.items()}
    for s in sorted(exact, key=lambda s: exact[s] - take[s], reverse=True)[: n - sum(take.values())]:
        take[s] += 1
    rng = random.Random(seed)
    ids = [t["task_id"] for s in sorted(by) for t in rng.sample(by[s], take[s])]
    info = {"total": len(all_tasks), "strata_full": {s: len(ts) for s, ts in by.items()},
            "strata_sample": take}
    return ids, info


def run_dir(name: str) -> Path:
    return RUNS / name


def plan_of(name: str) -> dict:
    path = run_dir(name) / "plan.json"
    if not path.exists():
        sys.exit(f"no plan: bu.sh sample {name}")
    return json.loads(path.read_text())


def cmd_list(a) -> None:
    ids, info = sample(tasks(), a.n, a.seed)
    print(json.dumps({**info, "sample": ids}, indent=2))


def cmd_sample(a) -> None:
    d = run_dir(a.run)
    if (d / "plan.json").exists():
        sys.exit(f"{d}/plan.json exists: a run keeps its ids")
    ids, info = sample(tasks(), a.n, a.seed)
    d.mkdir(parents=True, exist_ok=True)
    plan = {"benchmark": BENCHMARK, "n": a.n, "seed": a.seed, "ids": ids, **info,
            "created": datetime.now(UTC).isoformat()}
    (d / "plan.json").write_text(json.dumps(plan, indent=2))
    print(f"{len(ids)} tasks in {d}/plan.json")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def trace_of(goal: str, run: dict | None, task: dict, notes: list[str]) -> dict:
    """The benchmark's trace (run_eval.run_task) from autobrowse's run JSON."""
    run = run or {"steps": [], "shots": [], "summary": None}
    images = []
    for i, p in enumerate(run["shots"], 1):
        try:
            images.append(base64.b64encode(Path(p).read_bytes()).decode())
        except OSError:
            notes.append(f"Capture {i} could not be read from the saved screenshots.")
    return {
        "agent_task": goal,
        "final_result": run.get("summary") or "Agent did not return a result",
        "agent_steps": [s["line"] for s in run["steps"]],
        "ground_truth": task.get("answer"),
        "screenshots_b64": images,
        "output_files_text": "",
        "evidence_notes": notes,
    }


def run_one(task: dict, d: Path, a) -> dict:
    tid = task["task_id"]
    work = d / "work" / tid
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    out = work / "run.json"
    # Each task in its own empty profile and recordings dir: no cookie or account of ours is near it.
    env = {
        **os.environ,
        "LLM_PROVIDER": a.provider,
        "PROFILES_DIR": str(work / "profiles"),
        "RECORDINGS_DIR": str(work / "recordings"),
        "BROWSER_HEADLESS": "false" if a.headed else "true",
        # Always set: the settings file's model belongs to its own provider.
        "LLM_MODEL": a.model,
    }
    argv = ["pnpm", "-s", "autobrowse", "agent", "bench", task["confirmed_task"],
            "--json", str(out), "--no-sign-in", "--no-os", "--max-steps", str(a.max_steps),
            "--port", str(free_port()), "--save", "bench"]
    if a.headed:
        argv.append("--headed")
    result = {"task_id": tid, "score": None, "raw_score": None, "steps": 0, "duration": 0, "cost": 0}
    t0 = time.time()
    with open(work / "agent.log", "w") as log:
        p = subprocess.Popen(argv, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            p.wait(timeout=a.timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, 15)
            p.wait()
            result["execution_error"] = f"Task timed out after {a.timeout}s"
    if p.returncode and "execution_error" not in result:
        result["execution_error"] = f"autobrowse exited {p.returncode}; see {work}/agent.log"
    run = json.loads(out.read_text()) if out.exists() else None
    trace = trace_of(task["confirmed_task"], run, task, [])
    result.update(steps=len(run["steps"]) if run else 0, duration=round(time.time() - t0, 1),
                  # Claude Code bills the subscription, not per token: tokens instead of dollars.
                  tokens=run["usage"] if run else None, status="awaiting_judge")
    shutil.rmtree(work / "profiles", ignore_errors=True)
    return {"benchmark": BENCHMARK, "agent": f"autobrowse/{a.provider}", "agent_trace": trace,
            "metrics": {k: result[k] for k in ("steps", "duration", "cost")}, "task": task, **result}


def cmd_run(a) -> None:
    plan = plan_of(a.run)
    d = run_dir(a.run)
    by_id = {t["task_id"]: t for t in tasks()}
    ids = [a.only] if a.only else plan["ids"]
    for i, tid in enumerate(ids, 1):
        saved = d / "results" / f"{tid}.json"
        if saved.exists() and not a.only:
            continue
        print(f"[{i}/{len(ids)}] {tid}", flush=True)
        payload = run_one(by_id[tid], d, a)
        saved.parent.mkdir(parents=True, exist_ok=True)
        saved.write_text(json.dumps(payload, indent=2))
        print(f"  {payload['steps']} steps, {payload['duration']}s"
              + (f", {payload['execution_error']}" if "execution_error" in payload else ""), flush=True)


async def judge_all(a) -> None:
    sys.path.insert(0, str(CLONE))
    from evaluation import create_judge, judge_config, judge_trace  # noqa: PLC0415

    judge = create_judge(BENCHMARK)
    files = sorted((run_dir(a.run) / "results").glob("*.json"))
    waiting = [f for f in files if json.loads(f.read_text())["status"] == "awaiting_judge"]
    for f in waiting[: a.limit]:
        payload = json.loads(f.read_text())
        try:
            payload.update(await judge_trace(payload["task"], payload["agent_trace"], judge, BENCHMARK))
            payload["judge_config"] = judge_config(BENCHMARK, judge)
            payload["status"] = "judged"
        except Exception as exc:  # A broken judge is not a score of zero.
            payload.update(status="judge_error", error=f"{type(exc).__name__}: {exc}")
        f.write_text(json.dumps(payload, indent=2))
        print(f"{payload['task_id']}: {payload['status']} score={payload.get('score')}", flush=True)


def cmd_report(a) -> None:
    rows = [json.loads(f.read_text()) for f in sorted((run_dir(a.run) / "results").glob("*.json"))]
    plan = plan_of(a.run)
    status: dict[str, int] = {}
    for r in rows:
        status[r["status"]] = status.get(r["status"], 0) + 1
    scores = [r["score"] for r in rows if r["status"] == "judged" and r["score"] is not None]
    out = {"planned": len(plan["ids"]), "status": status}
    if scores:
        mean = sum(scores) / len(scores)
        sd = math.sqrt(sum((s - mean) ** 2 for s in scores) / max(1, len(scores) - 1))
        out |= {"judged": len(scores), "mean": round(mean, 2),
                "ci95": round(1.96 * sd / math.sqrt(len(scores)), 2)}
    if rows:
        out |= {"mean_steps": round(sum(r["steps"] for r in rows) / len(rows), 1),
                "mean_seconds": round(sum(r["duration"] for r in rows) / len(rows), 1)}
    print(json.dumps(out, indent=2))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("list", "sample"):
        s = sub.add_parser(name)
        if name == "sample":
            s.add_argument("run")
        s.add_argument("--n", type=int, default=30)
        s.add_argument("--seed", type=int, default=7)
    s = sub.add_parser("run")
    s.add_argument("run")
    s.add_argument("--only")
    s.add_argument("--max-steps", type=int, default=100)  # the benchmark's own budget
    s.add_argument("--timeout", type=int, default=900)
    s.add_argument("--provider", default="claude-code")
    s.add_argument("--model", default="sonnet")
    s.add_argument("--headed", action="store_true")
    s = sub.add_parser("judge")
    s.add_argument("run")
    s.add_argument("--limit", type=int, default=1)
    s = sub.add_parser("report")
    s.add_argument("run")
    a = p.parse_args()
    if a.cmd == "judge":
        asyncio.run(judge_all(a))
    else:
        {"list": cmd_list, "sample": cmd_sample, "run": cmd_run, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
