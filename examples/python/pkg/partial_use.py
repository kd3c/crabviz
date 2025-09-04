from functools import partial
from .util import greet  # relative import to test normalization

def make_partial():
    fn = partial(greet, 'x')  # higher-order reference should produce partial-ref edge
    return fn
