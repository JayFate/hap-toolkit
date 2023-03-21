/*
 * Copyright (c) 2023, the hapjs-platform Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const injectRef = Object.getPrototypeOf(global) || global

// 注入regeneratorRuntime
injectRef.regeneratorRuntime = require('@babel/runtime/regenerator')
