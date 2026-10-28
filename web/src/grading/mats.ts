// mats.ts - memory cleanup helper for OpenCV.js.
//
// OpenCV.js runs C++ compiled to WebAssembly. Every cv.Mat lives in WASM
// memory that JavaScript's garbage collector CAN'T see, so you must call
// .delete() yourself - like IDisposable/Dispose() in C#. Forget it and the
// phone runs out of memory after a few photos.
//
// MatTracker is our "using" block: track() everything you create, then call
// deleteAll() in a finally.

type Deletable = { delete(): void };

export class MatTracker {
  private items: Deletable[] = [];

  // Remember this object for cleanup, and hand it straight back.
  track<T extends Deletable>(item: T): T {
    this.items.push(item);
    return item;
  }

  deleteAll(): void {
    for (const item of this.items) item.delete();
    this.items = [];
  }
}
