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

var serialize = function(object) {
    // 0 -- Root node (NOP -- don't serialize)
    // 1 -- string
    // 2 -- object start
    // 3 -- object end
    // 4 -- object reference
    // 5 -- nop
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
        bufferSize++;
        switch(node.type) {
            case 0:
                {
                    // Two words for version string
                    bufferSize+=8;
                    node.remaining = 2;
                }
                break;
            case 1:
                {
                    // String
                    bufferSize+=4+(node.value.length*2);
                    // Each character in JavaScript is 2 bytes
                    // We can encode 4 bytes in 1 word, so divide by 4
                    // to find the word length. We don't try to be fancy
                    // and use UTF-8 conversions here even though they would save space.
                    // Converting to UTF-8 would be computationally expensive
                    // despite saving space. It would have simplified things if JavaScript
                    // just used UTF-8 to begin with....
                    node.remaining = Math.ceil((node.value.length*2)/4);
                    // Must encode at least 1 word.
                    node.remaining+=(!node.remaining);
                    // Don't forget the header
                    node.remaining++;
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
        }
        return node;
    };
    var serializeObject = function(obj) {
        switch(obj.toString) {
            case ''.toString:
                return insertNode(makeNode(1, obj));
                break;
                default:
                    // Serialize object
                    if(serializedMemo.get(obj)) {
                        // Non-local object reference (possible cycle)
                        return insertNode(makeNode(4, serializedMemo.get(obj)));
                    }
                    // Insert object header
                    var header = insertNode(makeNode(2, null));
                    for(var key in obj) {
                        serializeObject(key);
                        serializeObject(obj[key]);
                    }
                    // End of object
                    insertNode(makeNode(3, null));
                    serializedMemo.set(obj, header);
        }
    };
    insertNode(makeNode(0, null));
    serializeObject(object);
    var roundedSize = roundToWord(bufferSize);
    if(roundedSize != wordCount) {
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
    var state = 0;
    // String builder array
    var str = [];
    // Object builder
    var obj = null;
    // Stack of objects
    var obj_stack = [];
    // Stack of keys
    var key_stack = [];
    // Length for dynamically sized objects
    // such as strings and arrays.
    var len = 0;
    // Substate for returns
    var substate = 0;
    var assign_obj = function(value) {
      state = 1;
      switch(substate) {
          case 0:
              return true;
           case 1:
               // Add key
               if(!obj_stack.length) {
                   // End of object stack -- return
                   return true;
               }
               key_stack.push(value);
               substate = 2;
               return false;
            case 2:
                // Add value
                obj[key_stack.pop()] = value;
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
                                    // Begin object
                                    obj = {};
                                    obj_stack.push(obj);
                                    substate = 1;
                                    state = 1;
                                }
                                break;
                            case 3:
                                {
                                    // Object end (pop stack)
                                    obj = obj_stack.pop();
                                    state = 1;
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
        }
    }
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
        var basis = {test:{nest:'ed object'}};
        var serialized = serialize(basis);
        var deserialized = deserialize(serialized);
        if(JSON.stringify(basis) != JSON.stringify(deserialized)) {
            console.log(JSON.stringify(basis)+'!=' +JSON.stringify(deserialized));
        }
    }
    //testString();
    //testObjectStringDictionary();
    testNest();
};
selftest();

module.exports = {
    serialize,
    deserialize
};