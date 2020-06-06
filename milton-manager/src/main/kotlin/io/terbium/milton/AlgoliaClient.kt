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

import com.algolia.search.client.ClientSearch
import com.algolia.search.model.*
import com.algolia.search.model.search.Query
import kotlinx.serialization.json.json
import java.security.MessageDigest
import java.util.*
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AlgoliaClient @Inject constructor(
        @AlgoliaAccount algoliaAccount: String,
        @AlgoliaSecret algoliaSecret: String
) {
    private val client = ClientSearch(ApplicationID(algoliaAccount), APIKey(algoliaSecret))
    private val indexName = IndexName("posts")
    private val index = client.initIndex(indexName)
    private val maxRecordSize = 2 * 1024
    private val chunker = StringChunker(maxRecordSize)

    suspend fun indexPage(url: String, title: String, siteName: String?, storageId: String, content: String): Int {
        val objects = chunker.chunkString(content).mapIndexed { idx, part ->
            json {
                "objectID" to ObjectID("${sha256(url)}$idx")
                "title" to title
                "siteName" to siteName
                "text" to part
                "url" to url
                "storageId" to storageId
            }
        }

        index.saveObjects(objects)

        return objects.size
    }

    suspend fun search(queryString: String): List<AlgoliaRecord> {
        val query = Query(
                query = queryString,
                attributesToRetrieve = listOf(
                        Attribute("title"),
                        Attribute("siteName"),
                        Attribute("url"),
                        Attribute("storageId")
                )
        )

        val records = index.search(query).hits.map { AlgoliaRecord(
                title = it.json["title"]!!.primitive.content,
                siteName = it.json["siteName"]!!.primitive.content,
                url = it.json["url"]!!.primitive.content,
                storageId = it.json["storageId"]!!.primitive.content
        ) }

        // Deduplicate records, but keep them in order
        val urlSet = mutableSetOf<String>()
        val outputList = mutableListOf<AlgoliaRecord>()
        for (record in records) {
            if (record.url in urlSet) continue
            urlSet.add(record.url)
            outputList.add(record)
        }

        return outputList
    }

    suspend fun deletePage(url: String) {
        val browseResults = index.browseObjects(Query(
                query = url,
                restrictSearchableAttributes = listOf(Attribute("url")),
                attributesToRetrieve = listOf(
                        Attribute("url"),
                        Attribute("objectID")
                )
        ))
        val objectIds = browseResults.flatMap { it.hits }
                .filter { it["url"]!!.primitive.content == url }
                .map { ObjectID(it["objectID"]!!.primitive.content) }
        index.deleteObjects(objectIds)
    }

    private val shaDigest = MessageDigest.getInstance("SHA-256")
    private val b64enc = Base64.getEncoder()

    private fun sha256(s: String): String =
        b64enc.encodeToString(shaDigest.digest(s.toByteArray(Charsets.UTF_8)))
}
