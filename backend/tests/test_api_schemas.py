"""The response models cover the same grid channels as the recording model."""

from racecoach.api.schemas import ChannelArrays
from racecoach.model import GRID_CHANNELS


def test_channel_arrays_match_grid_channels() -> None:
    assert list(ChannelArrays.model_fields) == list(GRID_CHANNELS)


def test_every_json_route_has_a_response_model() -> None:
    from fastapi.routing import APIRoute

    from racecoach.api.routes import router

    bare = [r.path for r in router.routes if isinstance(r, APIRoute) and r.response_model is None]
    assert bare == []
