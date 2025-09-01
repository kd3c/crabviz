from ..beta.b_mod import beta_mid
from ..util.helpers import util_calc


def alpha_entry(x: int) -> int:
    """Entry function that starts a multi-hop chain alpha_entry -> beta_mid -> gamma_core -> delta_leaf"""
    return beta_mid(x) + util_calc(x)


def alpha_cycle(x: int) -> int:
    # Part of a cycle alpha_cycle -> beta_cycle -> gamma_cycle -> alpha_cycle
    from ..beta.b_mod import beta_cycle
    return beta_cycle(x - 1)
