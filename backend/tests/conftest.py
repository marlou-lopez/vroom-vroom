from pathlib import Path

import pytest

from racecoach.settings import Settings

# A developer's own dotenv file (API keys, base URL) must not leak into the tests.
Settings.model_config["env_file"] = None

FIXTURE = Path(__file__).parent / "fixtures" / "spa_720s.duckdb"


@pytest.fixture(scope="session")
def spa_fixture() -> Path:
    return FIXTURE
