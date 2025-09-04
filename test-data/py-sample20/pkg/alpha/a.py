from ..beta import bmod
from ..gamma import gamma_mod


def ping():
    return bmod.bfunc()

class A:
    def do(self):
        gamma_mod.gamma_func()
        return helper()

def helper():
    return 42
