from pkg.alpha.mod_a1 import fa1, AlphaClass
from pkg.alpha.mod_a2 import fa2
from pkg.beta.mod_b2 import fb2
from pkg.delta.inner2.mod_d_inner2 import inner2_func

def orchestrate(val: int) -> int:
    a = AlphaClass(val)
    r1 = fa1(val)
    r2 = fa2(val)
    r3 = fb2(val)
    r4 = inner2_func(val)
    return a.compute(r1 + r2 + r3 + r4)

if __name__ == "__main__":
    print(orchestrate(5))
