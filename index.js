const { version } = require('os');
const { stringify } = require('querystring');

var Buffer = require('buffer').Buffer;
var performance = require('perf_hooks').performance;

// TODO: Version number
// OpenBuffer in ASCII followed by version






var array = [
    function() {
        return 0;
    },
    function() {
        return 1;
    },
    function() {
        return 2;
    }
];

var versionString = Buffer.allocUnsafe(8);
versionString.write('OpenBuf', 'utf-8');
versionString.writeUInt8(0, 'OpenBuf'.length);

var u32FromBuffer = function(buffer) {
    return new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength/4);
};
var u8FromBuffer = function(buffer) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
};

var serialize = function(object) {
    // 0 -- Root node (NOP -- don't serialize)
    // 1 -- string
    // 2 -- object start
    // 3 -- object end
    // 4 -- object reference
    // 5 -- nop
    // 6 -- Buffer
    var serializedMemo = new Map();
    var graph = {next:null, type:0};
    var current = graph;
    var bufferSize = 0;
    var makeNode = function(type, value) {
        return {
            next:null,
            value:value,
            type:type,
            // Word offset this was serialized at
            wordOffset:0,
            // Number of words remaining
            remaining:0,
        };
    };
    var roundToWord = function(bufferSize) {
        var res = 4-(bufferSize % 4);
        res*=((bufferSize % 4) > 0);
        return bufferSize+res;
    };
    var insertNode = function(node) {
        current.next = node;
        current = node;
        bufferSize+=4;
        switch(node.type) {
            case 0:
                {
                    // Two words for version string
                    bufferSize+=4;
                    node.remaining = 2;
                }
                break;
            case 1:
                {
                    // Each character in JavaScript is 2 bytes
                    // We can encode 4 bytes in 1 word, so divide by 4
                    // to find the word length. We don't try to be fancy
                    // and use UTF-8 conversions here even though they would save space.
                    // Converting to UTF-8 would be computationally expensive
                    // despite saving space. It would have simplified things if JavaScript
                    // just used UTF-8 to begin with....
                    node.remaining = Math.ceil((node.value.length*2)/4);
                    // Don't forget the header
                    node.remaining++;
                    bufferSize+=(node.remaining-1)*4;
                }
                break;
                // TODO: Pack some useful data in here.
                // We're just wasting 3 bytes here.
                case 2:
                case 3:
                {
                    // Markers (object start/end)
                    node.remaining = 1;
                }
                break;
                case 4:
                    // Encode inline reference
                    node.remaining = 1;
                    break;
                    // 5 = nop
                    case 5:
                        node.remaining = 1;
                    break;
                    case 6:
                        node.remaining = Math.ceil(node.value.length/4)+1;
                        bufferSize+=(node.remaining-1)*4;
                        break;
        }
        return node;
    };
    var serializeObject = function(obj) {
        switch(obj.toString) {
            case ''.toString:
                return insertNode(makeNode(1, obj));
            case versionString.toString:
                // Buffer
                return insertNode(makeNode(6, u8FromBuffer(obj)));
                break;
                default:
                    // Serialize object
                    if(serializedMemo.get(obj)) {
                        // Non-local object reference (possible cycle)
                        return insertNode(makeNode(4, serializedMemo.get(obj)));
                    }
                    // Insert object header
                    var header = insertNode(makeNode(2, null));
                    serializedMemo.set(obj, header);
                    for(var key in obj) {
                        serializeObject(key);
                        serializeObject(obj[key]);
                    }
                    // End of object
                    insertNode(makeNode(3, null));
        }
    };
    insertNode(makeNode(0, null));
    serializeObject(object);
    var roundedSize = roundToWord(bufferSize);
    if(roundedSize != bufferSize) {
        insertNode(makeNode(5, null));
        bufferSize = roundedSize;
    }
    var retval = Buffer.allocUnsafe(bufferSize);
  
    var versionBufferWords = new u32FromBuffer(versionString);
    var u32 = u32FromBuffer(retval);
    var branch_arr = [null, null];
    // Total number of words
    var wordCount = 0;
    graph = graph.next;
    for(var i = 0;i<u32.length;i++) {
        branch_arr[0] = graph;
        branch_arr[1] = graph.next;
        wordCount +=((!wordCount)*graph.remaining);
        // Zero-based word index
        var wordIndex = wordCount-graph.remaining;
        graph.wordOffset = graph.wordOffset*(!wordIndex);
        graph.wordOffset+=i;
        switch(graph.type) {
            case 0:
                {
                    u32[i] = versionBufferWords[wordIndex];
                }
                break;
            case 1:
                {
                    // String (UTF-16)
                    var strIndex = (wordIndex*2) | 0;
                    var encodeOp = !strIndex;
                    strIndex-=2*(!encodeOp);
                    var word = graph.value.charCodeAt(strIndex) | (graph.value.charCodeAt(strIndex+1) << 16);
                    word*=!encodeOp;
                    // String OPCODE is conveniently 1.
                    word+=encodeOp*(1 | ((wordCount-1) << 8));
                    u32[i] = word;
                }
                break;
            case 2:
            case 3:
                u32[i] = graph.type;
                break;
            case 4:
                u32[i] = 4 | (graph.value.wordOffset << 8);
                break;
            case 5: // NOP
                u32[i] = 5;
                break;
                case 6:
                    // Buffer
                    {
                        // Little-Endian encoding
                        var op = 6 | (graph.value.length << 8);
                        var wx = !!wordIndex*(wordIndex-1);
                        var word = graph.value[wx *4];
                        word |= graph.value[(wx *4)+1] << 8;
                        word |= graph.value[(wx *4)+2] << 16;
                        word |= graph.value[(wx *4)+3] << 24;
                        word*= !!wordIndex;
                        word+=((!wordIndex)*(op));
                        u32[i] = word;
                    }
                    break;
        }
        graph.remaining--;
        wordCount *= !!graph.remaining;
        graph = branch_arr[(!graph.remaining) | 0];
    }
    return retval;
};

var deserialize = function(buffer) {
    var u32 = u32FromBuffer(buffer);
    var uversion = u32FromBuffer(versionString);
    if(u32[0] != uversion[0]) {
        throw new Error('Bad header');
    }
    if(u32[1] != uversion[1]) {
        throw new Error('Unsupported version');
    }
    var obj_map = new Map();
    var state = 0;
    // String builder array
    var str = [];
    // Object builder
    var obj = null;
    // obj, key, substate
    var stack = [];
    stack.push({obj:null, key:null, substate:0});
    var substate = 0;
    var key = null;
    // Length for dynamically sized objects
    // such as strings and arrays.
    var len = 0;
    var push = function() {
        stack.push({obj:obj, key:key, substate:substate});
    };
    var pop = function() {
        var stack_obj = stack.pop();
        obj = stack_obj.obj;
        key = stack_obj.key;
        substate = stack_obj.substate;
    };
    var assign_obj = function(value) {
      state = 1;
      switch(substate) {
          case 0:
              return true;
           case 1:
               // Add key
               key = value;
               substate = 2;
               return false;
            case 2:
                // Add value
                obj[key] = value;
                substate = 1;
            return false;
      }
    };
    for(var i = 0;i<u32.length;i++) {
        var word = u32[i];
        switch(state) {
            case 0:
                {
                    state = (i/1) | 0;
                }
                break;
            case 1:
                {
                    switch(word & 0xff) {
                        case 1:
                            {
                                // String
                                state = 2;
                                len = word >> 8;
                            }
                            break;
                            case 2:
                                {
                                    // Begin object (new stack frame)
                                    push();
                                    obj = {};
                                    obj_map[i] = obj;
                                    substate = 1;
                                    state = 1;
                                }
                                break;
                            case 3:
                                {
                                    // Object end (pop stack frame)
                                    var tmp = obj;
                                    pop();
                                    state = 1;
                                    if(assign_obj(tmp)) {
                                        return tmp;
                                    }
                                }
                                break;
                                case 4:
                                    {
                                        // Object reference
                                        var ptr = word >> 8;
                                        var obj = obj_map[ptr];
                                        if(assign_obj(obj)) {
                                            return obj;
                                        }
                                    }
                                    break;
                            case 5:
                                {
                                    // NOP -- Continue decoding
                                }
                                break;
                            case 6:
                                {
                                    // Buffer (direct map -- no memcpy needed)
                                    var size = word >> 8;
                                    var ret = Buffer.from(u32.buffer, u32.byteOffset+((i+1)*4), size);
                                    len = Math.ceil(size/4);
                                    if(assign_obj(ret)) {
                                        return ret;
                                    }
                                    state = 3;
                                }
                                break;
                        default:
                            throw new Error('Bad token in stream '+(word & 0xff));
                    }
                }
                break;
            case 2:
                {
                    // String decode loop
                    str.push(String.fromCharCode(word & 0xffff));
                    str.push(String.fromCharCode(word >> 16));
                    len--;
                    if(!len) {
                        if(str[str.length-1] == '\0') {
                            str.pop();
                        }
                        var retval = str.join('');
                        str = [];
                        if(assign_obj(retval)) {
                            return retval;
                        }
                    }
                }
                break;
                case 3:
                    {
                    // Wait for bytes to go by(te)...
                    len--;
                    if(len == 0) {
                        state = 1;
                    }
                    break;
                }
        }
    }
    return null;
};

var selftest = function() {
    var testString = function() {
        var serialized = serialize('test');
        var str = deserialize(serialized);
        if(str != 'test') {
            console.log(str+'!=test');
            process.exit(0);
        }
    };
    var testObjectStringDictionary = function(){
        var basis = {test:'me', today:'or maybe not'};
        var serialized = serialize(basis);
        var deserialized = deserialize(serialized);
        if(JSON.stringify(basis) != JSON.stringify(deserialized)) {
            console.log(JSON.stringify(basis)+'!=' +JSON.stringify(deserialized));
        }
    }
    var testNest = function(){
        var basis = {test:{nest:'ed object', test:'2', obj2:{why:{not:'another'}}}};
        var serialized = serialize(basis);
        var deserialized = deserialize(serialized);
        if(JSON.stringify(basis) != JSON.stringify(deserialized)) {
            console.log(JSON.stringify(basis)+'!=' +JSON.stringify(deserialized));
        }
    }
    var testCycle = function(){
        var basis = {i:{}};
        basis.i.contain = 'myself';
        basis.i.ptr = basis;
        var serialized = serialize(basis);
        var deserialized = deserialize(serialized);
        // This is something we can't test by JSON serialization
        // This is an edge-case that's impossible to handle in JSON
        // so we have to manually compare here
        if(deserialized.i.ptr != deserialized) {
            console.log('PTR ERROR');
        }
    }
    var testBlob = function() {
        var basis = {
            theblob:Buffer.allocUnsafe(17),
            str:'test'
        };
        for(var i = 0;i<basis.theblob.byteLength;i++) {
            basis.theblob.writeUInt8(i, i);
        } 
        var serialized = serialize(basis);
        var deserialized = deserialize(serialized);
        if(deserialized.str != 'test') {
            console.log('Bad string value in testBlob');
        }
        for(var i = 0;i<deserialized.theblob.byteLength;i++) {
            if(deserialized.theblob[i] != i) {
                console.log('Bytes got eaten by theblob at index '+i+' got '+deserialized.theblob[i]);
            }
        }
    };
    var perfTest = function() {
        var basis = {test:{nest:'ed object', test:'2', obj2:{why:{not:'another'}}}};
        var start = performance.now();
        for(var i = 0;i<10000;i++) {
        var serialized = serialize(basis);
        var deserialized = deserialize(serialized);
        }
        var end = performance.now();
        var dur0 = end-start;
        start = performance.now();
        for(var i = 0;i<10000;i++) {
            var serialized = serialize(basis);
            var deserialized = deserialize(serialized);
        }
        var end = performance.now();
        var dur1 = end=start;
        console.log('JSON '+dur1+', custom '+dur0);
    };
    testString();
    testObjectStringDictionary();
    testNest();
    testCycle();
    testBlob();
    perfTest();
};
//selftest();

module.exports = {
    serialize,
    deserialize
};