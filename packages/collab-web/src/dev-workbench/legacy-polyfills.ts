/**
 * The sole Dev browser entry. Load the locally bundled standards implementation
 * before evaluating React or any application dependency, including on modern Edge.
 * stable includes Promise, Symbol/iterators, Map/Set/WeakMap, typed arrays, URL,
 * URLSearchParams, queueMicrotask, and the modern Object/Array/String methods.
 */
import "core-js/stable";
import "./main";
