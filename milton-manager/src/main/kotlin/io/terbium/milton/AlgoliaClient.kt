package io.terbium.milton

import com.algolia.search.client.ClientSearch
import com.algolia.search.model.*
import com.algolia.search.model.search.Query
import kotlinx.serialization.json.json
import java.security.MessageDigest
import java.util.*

class AlgoliaClient(algoliaAccount: String, algoliaSecret: String) {
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
                        Attribute("url")
                )
        )

        val records = index.search(query).hits.map { AlgoliaRecord(
                title = it.json["title"]!!.primitive.content,
                siteName = it.json["siteName"]!!.primitive.content,
                url = it.json["url"]!!.primitive.content
        ) }

        // Deduplicate records
        val urlSet = mutableSetOf<String>()
        val outputList = mutableListOf<AlgoliaRecord>()
        for (record in records) {
            if (record.url in urlSet) continue
            urlSet.add(record.url)
            outputList.add(record)
        }

        return outputList
    }

    private val shaDigest = MessageDigest.getInstance("SHA-256")
    private val b64enc = Base64.getEncoder()

    private fun sha256(s: String): String =
        b64enc.encodeToString(shaDigest.digest(s.toByteArray(Charsets.UTF_8)))
}
