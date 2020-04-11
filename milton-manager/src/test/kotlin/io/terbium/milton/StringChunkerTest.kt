package io.terbium.milton

import kotlin.test.Test
import kotlin.test.assertEquals

class StringChunkerTest {
    @Test
    fun testChunk() {
        val chunker = StringChunker(15)
        assertEquals(listOf("abc def\nghi jk", "mno pqr"), chunker.chunkString("abc def\nghi jk\nmno pqr"))
        assertEquals(listOf("01234567890123", "01234\n01234"), chunker.chunkString("01234567890123 01234\n01234"))
    }
}
