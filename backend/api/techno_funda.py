import logging
import math

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.models.database import get_db
from backend.services.techno_funda_service import TapetideBudget, TechnoFundaService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/techno-funda", tags=["techno-funda"])


def _clean(value):
    """JSON-safe: drop NaN/inf, unwrap numpy scalars."""
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


@router.get("/search")
async def search(q: str = Query(..., min_length=1, max_length=60), deep: bool = False, db: Session = Depends(get_db)):
    return {"results": await TechnoFundaService(db).search(q, deep=deep), "quota": TapetideBudget.status()}


@router.get("/quota")
def quota():
    return TapetideBudget.status()


@router.get("/analyze/{symbol}")
async def analyze(symbol: str, refresh: bool = False, refresh_fundamentals: bool = False, db: Session = Depends(get_db)):
    try:
        result = await TechnoFundaService(db).analyze(symbol, refresh=refresh, refresh_fundamentals=refresh_fundamentals)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("TechnoFunda analysis failed for %s", symbol)
        raise HTTPException(status_code=502, detail=f"Analysis failed: {e}")
    return _clean(result)
