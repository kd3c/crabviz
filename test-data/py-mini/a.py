from b import helper

def foo():
    bar()
    helper()

def bar():
    pass

class K:
    def baz(self):
        bar()
        self.internal()

    def internal(self):
        pass
