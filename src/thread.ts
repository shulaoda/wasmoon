import { Decoration } from './decoration'
import { LUA_MULTRET, LuaResumeResult, LuaReturn, LuaState, LuaType, PointerSize } from './types'
import { Pointer } from './pointer'
import LuaTypeExtension from './type-extension'
import MultiReturn from './multireturn'
import type Global from './global'
import type LuaWasm from './luawasm'

export interface OrderedExtension {
    // Bigger is more important
    priority: number
    extension: LuaTypeExtension<unknown>
}

export default class Thread {
    public readonly address: LuaState = 0
    public readonly cmodule: LuaWasm
    protected typeExtensions: OrderedExtension[]
    private closed = false

    private global: Global | this

    public constructor(cmodule: LuaWasm, typeExtensions: OrderedExtension[], address: number, global?: Global) {
        this.cmodule = cmodule
        this.typeExtensions = typeExtensions
        this.address = address
        this.global = global ?? this
    }

    public get(name: string): any {
        const type = this.cmodule.lua_getglobal(this.address, name)
        return this.getValue(-1, type)
    }

    public set(name: string, value: any): void {
        this.pushValue(value)
        this.cmodule.lua_setglobal(this.address, name)
    }

    public newThread(): Thread {
        return new Thread(this.cmodule, this.typeExtensions, this.cmodule.lua_newthread(this.address))
    }

    public resetThread(): void {
        this.assertOk(this.cmodule.lua_resetthread(this.address))
    }

    public loadString(luaCode: string): void {
        this.assertOk(this.cmodule.luaL_loadstring(this.address, luaCode))
    }

    public loadFile(filename: string): void {
        this.assertOk(this.cmodule.luaL_loadfilex(this.address, filename, null))
    }

    public resume(argCount = 0): LuaResumeResult {
        const dataPointer = this.cmodule.module._malloc(PointerSize)
        try {
            this.cmodule.module.setValue(dataPointer, 0, 'i32')
            const luaResult = this.cmodule.lua_resume(this.address, null, argCount, dataPointer)
            this.assertOk(luaResult)
            return {
                result: luaResult,
                resultCount: this.cmodule.module.getValue(dataPointer, 'i32'),
            }
        } finally {
            this.cmodule.module._free(dataPointer)
        }
    }

    public getTop(): number {
        return this.cmodule.lua_gettop(this.address)
    }

    public setTop(index: number): void {
        this.cmodule.lua_settop(this.address, index)
    }

    public remove(index: number): void {
        return this.cmodule.lua_remove(this.address, index)
    }

    public async run(argCount = 0): Promise<MultiReturn> {
        let resumeResult: LuaResumeResult = this.resume(argCount)
        while (resumeResult.result === LuaReturn.Yield) {
            if (resumeResult.resultCount > 0) {
                const lastValue = this.getValue(-1)
                this.pop(resumeResult.resultCount)

                // If there's a result and it's a promise, then wait for it.
                if (lastValue === Promise.resolve(lastValue)) {
                    await lastValue
                } else {
                    // If it's a non-promise, then skip a tick to yield for promises, timers, etc.
                    await new Promise((resolve) => setImmediate(resolve))
                }
            } else {
                // If there's nothing to yield, then skip a tick to yield for promises, timers, etc.
                await new Promise((resolve) => setImmediate(resolve))
            }

            resumeResult = this.resume(0)
        }
        return this.getStackValues()
    }

    public pop(count = 1): void {
        this.cmodule.lua_pop(this.address, count)
    }

    public call(name: string, ...args: any[]): MultiReturn {
        const type = this.cmodule.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        this.cmodule.lua_callk(this.address, args.length, LUA_MULTRET, 0, null)
        return this.getStackValues()
    }

    public getStackValues(): MultiReturn {
        const returns = this.cmodule.lua_gettop(this.address)
        const returnValues = new MultiReturn(returns)

        for (let i = 0; i < returns; i++) {
            returnValues[i] = this.getValue(i + 1)
        }

        return returnValues
    }

    public stateToThread(L: LuaState): Thread {
        return L === this.global.address ? this.global : new Thread(this.cmodule, this.typeExtensions, L, this.global as Global)
    }

    public pushValue(rawValue: any, userdata?: any): void {
        const decoratedValue = this.getValueDecorations(rawValue)
        const options = decoratedValue.options
        let target = decoratedValue.target

        if (target instanceof Thread) {
            this.cmodule.lua_pushthread(target.address)
            return
        }

        // First to allow overriding default behaviour, except for threads
        if (!this.typeExtensions.find((wrapper) => wrapper.extension.pushValue(this, decoratedValue, userdata))) {
            if (target === null) {
                target = undefined
            }

            switch (typeof target) {
                case 'undefined':
                    this.cmodule.lua_pushnil(this.address)
                    break
                case 'number':
                    if (Number.isInteger(target)) {
                        this.cmodule.lua_pushinteger(this.address, target)
                    } else {
                        this.cmodule.lua_pushnumber(this.address, target)
                    }
                    break
                case 'string':
                    this.cmodule.lua_pushstring(this.address, target)
                    break
                case 'boolean':
                    this.cmodule.lua_pushboolean(this.address, target ? 1 : 0)
                    break
                default:
                    throw new Error(`The type '${typeof target}' is not supported by Lua`)
            }
        }

        if (options?.metatable) {
            this.setMetatable(options.metatable, -1)
        }
    }

    public setMetatable(metatable: Record<any, any>, index: number): void {
        index = this.cmodule.lua_absindex(this.address, index)
        if (this.cmodule.lua_getmetatable(this.address, index)) {
            this.pop(1)
            throw new Error('data already has associated metatable')
        }

        this.pushValue(metatable)
        this.cmodule.lua_setmetatable(this.address, index)
    }

    public getMetatableName(index: number): string | undefined {
        const metatableNameType = this.cmodule.luaL_getmetafield(this.address, index, '__name')
        if (metatableNameType === LuaType.Nil) {
            return undefined
        }

        if (metatableNameType !== LuaType.String) {
            // Pop the metafield if it's not a string
            this.pop(1)
            return undefined
        }

        const name = this.cmodule.lua_tolstring(this.address, -1, null)
        // This is popping the luaL_getmetafield result which only pushes with type is not nil.
        this.pop(1)

        return name
    }

    public getValue(idx: number, inputType: LuaType | undefined = undefined, userdata?: any): any {
        idx = this.cmodule.lua_absindex(this.address, idx)

        // Before the below to allow overriding default behaviour.
        const metatableName = this.getMetatableName(idx)
        const type: LuaType = inputType || this.cmodule.lua_type(this.address, idx)

        const typeExtensionWrapper = this.typeExtensions.find((wrapper) => wrapper.extension.isType(this, idx, type, metatableName))
        if (typeExtensionWrapper) {
            return typeExtensionWrapper.extension.getValue(this, idx, userdata)
        }

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return this.cmodule.lua_tonumberx(this.address, idx, null)
            case LuaType.String:
                return this.cmodule.lua_tolstring(this.address, idx, null)
            case LuaType.Boolean:
                return Boolean(this.cmodule.lua_toboolean(this.address, idx))
            case LuaType.Thread: {
                return this.stateToThread(this.cmodule.lua_tothread(this.address, idx))
            }
            // Fallthrough if unrecognised user data
            default:
                console.warn(`The type '${this.cmodule.lua_typename(this.address, type)}' returned is not supported on JS`)
                return new Pointer(this.cmodule.lua_topointer(this.address, idx))
        }
    }

    public close(): void {
        if (!this.closed) {
            return
        }

        this.closed = true
        // Do this before removing the gc to force
        this.cmodule.lua_close(this.address)
    }

    public getPointer(index: number): Pointer {
        return new Pointer(this.cmodule.lua_topointer(this.address, index))
    }

    public isClosed(): boolean {
        return !this.address || this.closed
    }

    public dumpStack(log = console.log): void {
        const top = this.cmodule.lua_gettop(this.address)

        for (let i = 1; i <= top; i++) {
            const type = this.cmodule.lua_type(this.address, i)
            const pointer = this.getPointer(i)
            const name = this.cmodule.luaL_tolstring(this.address, i, null)
            this.pop(1)
            const value = this.getValue(i, type)

            const typename = this.cmodule.lua_typename(this.address, type)
            log(i, typename, pointer, name, value)
        }
    }

    private assertOk(result: LuaReturn): void {
        if (result !== LuaReturn.Ok && result !== LuaReturn.Yield) {
            const resultString = LuaReturn[result]
            let message = `Lua Error(${resultString}/${result})`
            if (this.cmodule.lua_gettop(this.address) > 0) {
                if (result === LuaReturn.ErrorMem) {
                    // If there's no memory just do a normal to string.
                    const error = this.cmodule.lua_tolstring(this.address, -1, null)
                    message += `: ${error}`
                } else {
                    // Calls __tostring if it exists and pushes onto the stack.
                    const error = this.cmodule.luaL_tolstring(this.address, -1, null)
                    message += `: ${error}`
                    // Pops the string pushed by luaL_tolstring
                    this.pop()
                }
            }
            throw new Error(message)
        }
    }

    private getValueDecorations(value: any): Decoration {
        return value instanceof Decoration ? value : new Decoration(value, {})
    }
}
