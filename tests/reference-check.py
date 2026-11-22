"""Independent analytical checks and deterministic scientific reference fixtures.

Uses only Python's standard library. This script does not execute the R engine.
Run from any directory: python tests/reference-check.py
"""

from __future__ import annotations

import csv
import json
import math
import random
from fractions import Fraction
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MODELS = ("competitive", "uncompetitive", "noncompetitive", "mixed")
S_LEVELS = (2.0, 5.0, 10.0, 20.0, 40.0, 80.0, 160.0, 320.0)
I_LEVELS = (0.0, 5.0, 20.0, 60.0)
PARAMETERS = {"Vmax": 120.0, "Km": 35.0, "Ki": 18.0, "Kis": 12.0, "Kii": 65.0}


def rate(model: str, s: float, inhibitor: float, p: dict[str, float]) -> float:
    """Reference expressed through the general mixed-inhibition equation.

    Independent from app implementation: special cases select the two
    concentration-dependent alpha coefficients before evaluating one equation.
    """
    if model == "competitive":
        alpha, alpha_prime = 1.0 + inhibitor / p["Ki"], 1.0
    elif model == "uncompetitive":
        alpha, alpha_prime = 1.0, 1.0 + inhibitor / p["Ki"]
    elif model == "noncompetitive":
        alpha = alpha_prime = 1.0 + inhibitor / p["Ki"]
    elif model == "mixed":
        alpha, alpha_prime = 1.0 + inhibitor / p["Kis"], 1.0 + inhibitor / p["Kii"]
    else:
        raise ValueError(f"Unknown model: {model}")
    return p["Vmax"] * s / (alpha * p["Km"] + alpha_prime * s)


def near(actual: float, expected: float, label: str, rel: float = 1e-10) -> None:
    if not math.isclose(actual, expected, rel_tol=rel, abs_tol=1e-10):
        raise AssertionError(f"{label}: expected {expected}, got {actual}")


def check_analytical_references() -> int:
    """Check fixed hand-calculated values and meaningful biochemical limits."""
    checks = 0
    p = {"Vmax": 100.0, "Km": 20.0, "Ki": 10.0, "Kis": 10.0, "Kii": 40.0}
    # At S=80 and I=10, the three one-Ki models give distinct rates.
    for model, expected in (
        ("competitive", Fraction(200, 3)),
        ("uncompetitive", Fraction(400, 9)),
        ("noncompetitive", Fraction(40, 1)),
    ):
        near(rate(model, 80, 10, p), float(expected), f"closed-form {model}")
        checks += 1
    # Mixed: S=20,I=20 => 2000 / (20*3 + 20*1.5) = 200/9.
    near(rate("mixed", 20, 20, p), float(Fraction(200, 9)), "closed-form mixed")
    checks += 1
    for model in MODELS:
        near(rate(model, p["Km"], 0, p), p["Vmax"] / 2, f"{model}: half maximum")
        near(rate(model, 0, 20, p), 0, f"{model}: zero-substrate limit")
        checks += 2
        for s in S_LEVELS:
            near(rate(model, s, 0, p), 100 * s / (20 + s), f"{model}: no inhibitor")
            checks += 1
        # Increasing inhibitor lowers rates for these positive parameters.
        inhibited = [rate(model, 20, i, p) for i in I_LEVELS]
        assert all(a > b for a, b in zip(inhibited, inhibited[1:])), model
        checks += 1
        # Increasing S raises the rate; no impossible negative rates appear.
        substrate_series = [rate(model, s, 20, p) for s in S_LEVELS]
        assert all(a < b for a, b in zip(substrate_series, substrate_series[1:])), model
        assert all(0 <= v <= p["Vmax"] for v in substrate_series), model
        checks += 2
    equal_binding = dict(p, Kis=10.0, Kii=10.0)
    for s in S_LEVELS:
        for i in I_LEVELS:
            near(rate("mixed", s, i, equal_binding), rate("noncompetitive", s, i, p),
                 "equal mixed constants reduce to noncompetitive")
            checks += 1
    # Large binding constants recover the respective limiting models.
    near(rate("mixed", 80, 10, dict(p, Kii=1e15)), rate("competitive", 80, 10, p),
         "mixed competitive limit")
    near(rate("mixed", 80, 10, dict(p, Kis=1e15, Kii=10)), rate("uncompetitive", 80, 10, p),
         "mixed uncompetitive limit")
    checks += 2
    return checks


def write_fixture(model: str, noise_sd: float, seed: int, name: str,
                  inhibitor_levels: tuple[float, ...] = I_LEVELS) -> dict:
    rng = random.Random(seed)
    rows = []
    for i in inhibitor_levels:
        for s in S_LEVELS:
            for _ in range(3):
                observed = rate(model, s, i, PARAMETERS)
                if noise_sd:
                    observed += rng.gauss(0, noise_sd)
                # Do not clip negative measured rates: clipping would change
                # the stated additive Gaussian observation model.
                rows.append({"S": s, "I": i, "v": observed})
    path = DATA / name
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=("S", "I", "v"), lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: f"{v:.12g}" for k, v in row.items()})
    parameter_names = ("Vmax", "Km", "Kis", "Kii") if model == "mixed" else ("Vmax", "Km", "Ki")
    return {
        "file": name,
        "model": model,
        "parameters": {k: PARAMETERS[k] for k in parameter_names},
        "observation_model": "additive independent Gaussian noise; no clipping",
        "noise_sd": noise_sd,
        "seed": seed,
        "n": len(rows),
        "replicates_per_condition": 3,
        "substrate_levels": S_LEVELS,
        "inhibitor_levels": inhibitor_levels,
        "units": {"S": "uM", "I": "uM", "v": "uM/min"},
    }


def check_written_fixture(meta: dict) -> int:
    with (DATA / meta["file"]).open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == ["S", "I", "v"]
        rows = [{k: float(v) for k, v in row.items()} for row in reader]
    assert len(rows) == meta["n"]
    assert len({(row["S"], row["I"]) for row in rows}) == 32
    assert all(math.isfinite(value) for row in rows for value in row.values())
    assert all(row["S"] > 0 and row["I"] >= 0 for row in rows)
    if meta["noise_sd"] == 0:
        for row in rows:
            near(row["v"], rate(meta["model"], row["S"], row["I"], PARAMETERS),
                 f"CSV precision {meta['file']}", rel=2e-11)
    else:
        assert any(abs(row["v"] - rate(meta["model"], row["S"], row["I"], PARAMETERS)) > 1e-6
                   for row in rows)
    return 6


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    checks = check_analytical_references()
    fixtures = []
    for index, model in enumerate(MODELS):
        for label, sd in (("noiseless", 0.0), ("noisy", 1.2)):
            fixtures.append(write_fixture(model, sd, 4510 + index,
                                          f"{model}-{label}.csv"))
    # Deliberately weak design: inhibitor concentrations are too small relative
    # to the generating binding constant to give strong discrimination at this
    # noise level. No expected winning model is asserted for this challenge.
    weak = write_fixture("competitive", 1.2, 9917, "weak-inhibition-noisy.csv",
                         (0.0, 0.05, 0.10, 0.20))
    weak["purpose"] = "limited-discrimination test; do not assume a reliable winning model"
    fixtures.append(weak)
    for fixture in fixtures:
        checks += check_written_fixture(fixture)
    manifest = {
        "provenance": "Synthetic reference data generated by tests/reference-check.py; not experimental observations",
        "generator_version": 1,
        "reference_checks": checks,
        "fixtures": fixtures,
        "recovery_evaluation": {
            "status": "not evaluated by this reference-only script",
            "suggested_noiseless_relative_parameter_tolerance": 0.005,
            "note": "Numerical tolerance is a computational benchmark, not a scientific uncertainty interval. Record actual R recovery separately.",
        },
    }
    (DATA / "ground-truth.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"PASS: {checks} independent analytical/fixture checks; {len(fixtures)} deterministic CSV fixtures written.")
    print("Not tested here: R optimization, model recovery, browser runtime, UI or exports.")


if __name__ == "__main__":
    main()
