from .util import greet

class Worker:
    def __init__(self, id: int):
        self.id = id

    def run(self):
        return greet(str(self.id))
