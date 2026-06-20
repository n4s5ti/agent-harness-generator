import importlib.util, json, random, sys

def load(path):
    spec = importlib.util.spec_from_file_location("target", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def main():
    path, seed, iters = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    mod = load(path)
    rng = random.Random(seed)
    falsified = False
    exc_type = None
    used = 0
    for _ in range(iters):
        used += 1
        a = rng.randint(-1000, 1000)
        b = rng.randint(-1000, 1000)
        try:
            mod.run(a, b)
        except Exception as e:  # invariant: run is total on bounded ints
            falsified = True
            exc_type = type(e).__name__
            break
    print(json.dumps({"falsified": falsified, "exceptionClass": exc_type, "iterations": used}))

if __name__ == "__main__":
    main()
