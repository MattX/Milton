/*
 * Copyright 2020 The Milton Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package io.terbium.milton

class StringChunker(private val chunkSize: Int) {
    fun chunkString(s: String): List<String> {
        val parts = s.split('\n')
                .map { it.trim() }
                .filter { !it.isBlank() }
                .flatMap { chunkWords(it) }
        return accumulate(parts.asSequence(), '\n')
    }

    private fun chunkWords(s: String): List<String> {
        val words = s.split("\\s+".toRegex())
        return accumulate(words.asSequence(), ' ')
    }

    private fun accumulate(parts: Sequence<String>, sep: Char): List<String> {
        val chunks: MutableList<String> = mutableListOf()
        var currentChunk = mutableListOf<String>()
        var currentSize = 0

        for (part in parts) {
            val partLen = part.length
            if (currentSize + partLen + 1 > chunkSize) {
                chunks.add(currentChunk.joinToString(sep.toString()))
                currentChunk = mutableListOf(part)
                currentSize = partLen
            } else {
                currentChunk.add(part)
                currentSize += partLen + 1
            }
        }

        if (currentSize > 0) {
            chunks.add(currentChunk.joinToString(sep.toString()))
        }

        return chunks
    }
}