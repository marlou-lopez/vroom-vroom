from pathlib import Path

import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "spa_720s.duckdb"


@pytest.fixture(scope="session")
def spa_fixture() -> Path:
    return FIXTURE
