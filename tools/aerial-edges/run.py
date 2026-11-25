"""Entry point: `python -I` leaves the script's folder off the path, so add it and run build.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import main  # noqa: E402

main()
