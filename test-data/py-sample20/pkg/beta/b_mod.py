from ..gamma.inner.g_mod import gamma_core, gamma_cycle


def beta_mid(y: int) -> int:
    return gamma_core(y) * 2


def beta_cycle(val: int) -> int:
    # cycle beta_cycle -> gamma_cycle
    return gamma_cycle(val - 2)
