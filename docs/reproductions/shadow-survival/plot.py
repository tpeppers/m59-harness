"""Render the observed Cccc comparison from the published evidence bundle."""
import gzip
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault("MPLCONFIGDIR", str(HERE / "../../../substrate/shadow-survival-2026-09-14/mpl"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

data = json.loads(gzip.decompress((HERE / "evidence.json.gz").read_bytes()))
fig, ax = plt.subplots(figsize=(10, 4.8), layout="constrained")
colors = {"control": "#146B9B", "extra": "#B23B48"}
for arm, label in [("control", "Shared protections only"), ("extra", "Extra reconnect decisions enabled")]:
    trial = next(t for t in data["trials"] if t["meta"]["id"] == f"matched-flatlands-shadow03-{arm}")
    samples = trial["samples"]
    zero = samples[0]["at"]
    living = [s for s in samples if s.get("room") != 1 and s.get("hp")]
    x = [(s["at"] - zero) / 1000 for s in living]
    y = [s["hp"]["value"] for s in living]
    ax.step(x, y, where="post", lw=2.5, color=colors[arm], label=label)
    end = trial["result"]["seconds"]
    if arm == "control":
        ax.scatter([end], [50], color=colors[arm], s=45, zorder=4)
        ax.annotate("Arrived at inn, 50 HP\n103 seconds", (end, 50), xytext=(112, 45),
                    color=colors[arm], fontsize=10, arrowprops={"arrowstyle": "-", "color": colors[arm]})
    else:
        ax.scatter([end], [4], marker="x", color=colors[arm], s=70, zorder=4)
        ax.annotate("Died after two reconnects\n188 seconds; still at start", (end, 4), xytext=(112, 17),
                    color=colors[arm], fontsize=10, arrowprops={"arrowstyle": "-", "color": colors[arm]})
ax.set(xlim=(0, 202), ylim=(0, 56), xlabel="Seconds since first trial sample", ylabel="Observed health (maximum 50)")
ax.set_title("Cccc: continuing reached safety; reconnecting delayed death", loc="left", fontsize=14, pad=14)
ax.grid(axis="y", alpha=.18)
ax.spines[["top", "right"]].set_visible(False)
ax.legend(loc="upper left", frameon=False)
fig.savefig(HERE / "ccc-health.png", dpi=180)
fig.savefig(HERE / "ccc-health.svg")
